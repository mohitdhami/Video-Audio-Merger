// Command videojoin runs a small web app: drop in one or more videos and one or
// more audio files, it merges them with ffmpeg and lets you download the result.
//
// Multiple videos are concatenated in order (stream copy when they share the
// same codec parameters, otherwise re-encoded) and the same happens for
// multiple audio files; the joined results are then merged into one output.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web
var webFS embed.FS

const (
	statusQueued  = "queued"
	statusRunning = "running"
	statusDone    = "done"
	statusError   = "error"

	maxFilesPerKind = 20
)

// ---------------------------------------------------------------- job state

type mediaInfo struct {
	Count      int     `json:"count,omitempty"`
	Duration   float64 `json:"duration,omitempty"`
	Codec      string  `json:"codec,omitempty"`
	AudioCodec string  `json:"audioCodec,omitempty"`
	Width      int     `json:"width,omitempty"`
	Height     int     `json:"height,omitempty"`
	Size       int64   `json:"size,omitempty"`
	HasAudio   bool    `json:"hasAudio,omitempty"`
}

type jobView struct {
	ID           string     `json:"id"`
	Status       string     `json:"status"`
	Progress     float64    `json:"progress"`
	Speed        string     `json:"speed,omitempty"`
	Stage        string     `json:"stage,omitempty"`
	Error        string     `json:"error,omitempty"`
	Log          string     `json:"log,omitempty"`
	DownloadURL  string     `json:"downloadURL,omitempty"`
	DownloadName string     `json:"downloadName,omitempty"`
	Video        mediaInfo  `json:"video"`
	Audio        mediaInfo  `json:"audio"`
	Files        []fileView `json:"files,omitempty"`
	OutputSize   int64      `json:"outputSize,omitempty"`
	ElapsedMs    int64      `json:"elapsedMs,omitempty"`
	Created      time.Time  `json:"created"`
}

// fileView tells the web UI which list (video or audio) a file really belongs
// to, so the lists can follow the content-based classification.
type fileView struct {
	Name string `json:"name"`
	Kind string `json:"kind,omitempty"` // video | audio | "" (not checked)
}

type job struct {
	mu sync.Mutex

	id  string
	dir string

	files []inputFile

	outputPath string
	outputName string

	status   string
	progress float64
	speed    string
	stage    string
	errMsg   string
	logs     []string

	videoInfo mediaInfo
	audioInfo mediaInfo

	created  time.Time
	started  time.Time
	finished time.Time

	cancel context.CancelFunc
}

func (j *job) view() jobView {
	j.mu.Lock()
	defer j.mu.Unlock()

	v := jobView{
		ID:       j.id,
		Status:   j.status,
		Progress: j.progress,
		Speed:    j.speed,
		Stage:    j.stage,
		Error:    j.errMsg,
		Video:    j.videoInfo,
		Audio:    j.audioInfo,
		Files:    fileViews(j.files),
		Created:  j.created,
	}
	if len(j.logs) > 0 {
		v.Log = strings.Join(j.logs, "\n")
	}
	if !j.started.IsZero() {
		end := j.finished
		if end.IsZero() {
			end = time.Now()
		}
		v.ElapsedMs = end.Sub(j.started).Milliseconds()
	}
	if j.status == statusDone && j.outputPath != "" {
		v.DownloadURL = "/api/jobs/" + j.id + "/file"
		v.DownloadName = j.outputName
		if st, err := os.Stat(j.outputPath); err == nil {
			v.OutputSize = st.Size()
		}
	}
	return v
}

func (j *job) setProgress(p float64) {
	j.mu.Lock()
	if p > j.progress {
		j.progress = p
	}
	j.mu.Unlock()
}

func (j *job) setSpeed(s string) {
	j.mu.Lock()
	j.speed = s
	j.mu.Unlock()
}

func (j *job) setStage(s string) {
	j.mu.Lock()
	j.stage = s
	j.mu.Unlock()
}

// addLog keeps the tail of ffmpeg's stderr output for diagnostics.
func (j *job) addLog(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	j.mu.Lock()
	j.logs = append(j.logs, line)
	if len(j.logs) > 60 {
		j.logs = j.logs[len(j.logs)-60:]
	}
	j.mu.Unlock()
}

func (j *job) fail(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	j.mu.Lock()
	j.status = statusError
	j.errMsg = msg
	j.stage = ""
	logs := strings.Join(j.logs, "\n")
	j.mu.Unlock()
	log.Printf("job %s failed: %s", j.id, msg)
	if logs != "" {
		log.Printf("job %s ffmpeg log:\n%s", j.id, logs)
	}
}

// ---------------------------------------------------------------- manager

type manager struct {
	mu    sync.Mutex
	jobs  map[string]*job
	root  string
	ownRN bool // true when we created root and should delete it on exit

	ttl        time.Duration
	maxUpload  int64
	jobTimeout time.Duration

	ffmpeg  string
	ffprobe string
}

func newManager(root string, ownRoot bool, ttl time.Duration, maxUpload int64, jobTimeout time.Duration, ffmpegBin, ffprobeBin string) *manager {
	return &manager{
		jobs:       make(map[string]*job),
		root:       root,
		ownRN:      ownRoot,
		ttl:        ttl,
		maxUpload:  maxUpload,
		jobTimeout: jobTimeout,
		ffmpeg:     ffmpegBin,
		ffprobe:    ffprobeBin,
	}
}

// newJob creates a job directory for an upload in progress. The job is only
// registered once the upload is complete and every file has been classified,
// so nobody can observe a half-filled job.
func (m *manager) newJob() (*job, error) {
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(m.root, "job-")
	if err != nil {
		return nil, err
	}
	return &job{
		id:      id,
		dir:     dir,
		status:  statusQueued,
		created: time.Now(),
	}, nil
}

// register makes the job visible to the API.
func (m *manager) register(j *job) {
	m.mu.Lock()
	m.jobs[j.id] = j
	m.mu.Unlock()
}

// discard drops an unregistered (or failed) job and deletes its files.
func (m *manager) discard(j *job) {
	m.mu.Lock()
	delete(m.jobs, j.id)
	m.mu.Unlock()
	os.RemoveAll(j.dir)
}

func (m *manager) get(id string) *job {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.jobs[id]
}

func (m *manager) remove(id string) {
	m.mu.Lock()
	j := m.jobs[id]
	delete(m.jobs, id)
	m.mu.Unlock()
	if j == nil {
		return
	}
	j.mu.Lock()
	cancel := j.cancel
	dir := j.dir
	j.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if dir != "" {
		os.RemoveAll(dir)
	}
}

// janitor removes finished jobs and deletes leftover files from previous runs.
func (m *manager) janitor(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			type victim struct {
				id   string
				dir  string
				kill context.CancelFunc
			}
			var stale []victim
			m.mu.Lock()
			for id, j := range m.jobs {
				j.mu.Lock()
				done := (j.status == statusDone || j.status == statusError) && !j.finished.IsZero() && time.Since(j.finished) > m.ttl
				if done {
					stale = append(stale, victim{id: id, dir: j.dir, kill: j.cancel})
					delete(m.jobs, id)
				}
				j.mu.Unlock()
			}
			m.mu.Unlock()
			for _, v := range stale {
				if v.kill != nil {
					v.kill()
				}
				os.RemoveAll(v.dir)
				log.Printf("janitor: removed job %s", v.id)
			}
		}
	}
}

func (m *manager) cleanupStaleDirs() {
	entries, err := os.ReadDir(m.root)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "job-") {
			p := filepath.Join(m.root, e.Name())
			os.RemoveAll(p)
			log.Printf("startup: removed stale job dir %s", p)
		}
	}
}

func (m *manager) close() {
	m.mu.Lock()
	var dirs []string
	for _, j := range m.jobs {
		j.mu.Lock()
		if j.cancel != nil {
			j.cancel()
		}
		dirs = append(dirs, j.dir)
		j.mu.Unlock()
	}
	m.jobs = make(map[string]*job)
	m.mu.Unlock()
	for _, d := range dirs {
		os.RemoveAll(d)
	}
	if m.ownRN {
		os.RemoveAll(m.root)
	}
}

// ------------------------------------------------------------------ ffmpeg

type options struct {
	Mode         string  // replace | mix
	VideoCodec   string  // copy | x264
	AudioCodec   string  // aac | copy
	AudioBitrate string  // 96k, 128k, 192k, 256k, 320k
	Container    string  // mp4 | mkv
	Shortest     bool    // trim result to the shortest input
	MixVolume    float64 // volume applied to the added audio track in mix mode
}

func defaultOptions() options {
	return options{
		Mode:         "replace",
		VideoCodec:   "copy",
		AudioCodec:   "aac",
		AudioBitrate: "192k",
		Container:    "mp4",
		Shortest:     true,
		MixVolume:    0.5,
	}
}

func (o *options) sanitize() {
	switch o.Mode {
	case "replace", "mix":
	default:
		o.Mode = "replace"
	}
	switch o.VideoCodec {
	case "copy", "x264":
	default:
		o.VideoCodec = "copy"
	}
	switch o.AudioCodec {
	case "aac", "copy":
	default:
		o.AudioCodec = "aac"
	}
	switch o.AudioBitrate {
	case "96k", "128k", "192k", "256k", "320k":
	default:
		o.AudioBitrate = "192k"
	}
	switch o.Container {
	case "mp4", "mkv":
	default:
		o.Container = "mp4"
	}
	if o.MixVolume < 0 || o.MixVolume > 2 || o.MixVolume != o.MixVolume {
		o.MixVolume = 0.5
	}
}

func applyField(o *options, name, value string) {
	switch name {
	case "mode":
		o.Mode = value
	case "videoCodec":
		o.VideoCodec = value
	case "audioCodec":
		o.AudioCodec = value
	case "audioBitrate":
		o.AudioBitrate = value
	case "container":
		o.Container = value
	case "shortest":
		switch strings.ToLower(value) {
		case "true", "1", "on", "yes":
			o.Shortest = true
		case "false", "0", "off", "no":
			o.Shortest = false
		}
	case "mixVolume":
		if f, err := strconv.ParseFloat(value, 64); err == nil {
			o.MixVolume = f
		}
	}
}

// ------------------------------------------------------------- media probe

type probeResult struct {
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
	Streams []struct {
		CodecType     string `json:"codec_type"`
		CodecName     string `json:"codec_name"`
		Duration      string `json:"duration"`
		Width         int    `json:"width"`
		Height        int    `json:"height"`
		PixFmt        string `json:"pix_fmt"`
		RFrameRate    string `json:"r_frame_rate"`
		SampleRate    string `json:"sample_rate"`
		Channels      int    `json:"channels"`
		ChannelLayout string `json:"channel_layout"`
		Disposition   struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
	} `json:"streams"`
}

type probeInfo struct {
	duration float64
	size     int64

	hasVideo  bool
	width     int
	height    int
	vcodec    string
	pixfmt    string
	framerate string

	hasAudio      bool
	acodec        string
	sampleRate    int
	channels      int
	channelLayout string
}

func probeFile(ffprobe, path string) (probeInfo, error) {
	var pi probeInfo

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, ffprobe,
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		path).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			msg := strings.TrimSpace(string(ee.Stderr))
			if msg != "" {
				return pi, errors.New(firstLine(msg))
			}
		}
		return pi, err
	}

	var pr probeResult
	if err := json.Unmarshal(out, &pr); err != nil {
		return pi, fmt.Errorf("could not parse ffprobe output: %w", err)
	}

	if d, err := strconv.ParseFloat(pr.Format.Duration, 64); err == nil {
		pi.duration = d
	}
	for _, s := range pr.Streams {
		switch s.CodecType {
		case "video":
			// Embedded cover art (album art in mp3/m4a, thumbnails) is not a
			// real video track, so a song with a picture stays audio-only.
			if s.Disposition.AttachedPic == 1 {
				continue
			}
			if pi.hasVideo {
				continue
			}
			pi.hasVideo = true
			pi.vcodec = s.CodecName
			pi.width = s.Width
			pi.height = s.Height
			pi.pixfmt = s.PixFmt
			pi.framerate = s.RFrameRate
			if pi.duration == 0 {
				if d, err := strconv.ParseFloat(s.Duration, 64); err == nil {
					pi.duration = d
				}
			}
		case "audio":
			if !pi.hasAudio {
				pi.acodec = s.CodecName
				pi.sampleRate, _ = strconv.Atoi(s.SampleRate)
				pi.channels = s.Channels
				pi.channelLayout = s.ChannelLayout
			}
			pi.hasAudio = true
			if pi.duration == 0 {
				if d, err := strconv.ParseFloat(s.Duration, 64); err == nil {
					pi.duration = d
				}
			}
		}
	}
	if st, err := os.Stat(path); err == nil {
		pi.size = st.Size()
	}
	return pi, nil
}

func (pi probeInfo) mediaInfo() mediaInfo {
	return mediaInfo{
		Count:      1,
		Duration:   pi.duration,
		Size:       pi.size,
		Codec:      pi.vcodec,
		AudioCodec: pi.acodec,
		Width:      pi.width,
		Height:     pi.height,
		HasAudio:   pi.hasAudio,
	}
}

// inputFile is one uploaded file. declared is the form field it arrived under
// ("video" or "audio"), i.e. the drop zone the user put it in - it is only a
// hint. What the file really contains is decided by ffprobe, never by its name
// or extension: kind and pi are filled in right after the upload finishes.
type inputFile struct {
	path     string
	name     string
	declared string
	kind     string // video | audio, decided by content
	pi       probeInfo
}

// source is one input file together with its probe result.
type source struct {
	path string
	name string
	pi   probeInfo
}

func fileViews(files []inputFile) []fileView {
	if len(files) == 0 {
		return nil
	}
	out := make([]fileView, 0, len(files))
	for _, f := range files {
		out = append(out, fileView{Name: f.name, Kind: f.kind})
	}
	return out
}

func aggregate(sources []source) mediaInfo {
	mi := mediaInfo{Count: len(sources)}
	for i, s := range sources {
		mi.Duration += s.pi.duration
		mi.Size += s.pi.size
		if s.pi.hasAudio {
			mi.HasAudio = true
		}
		if i == 0 {
			mi.Codec = s.pi.vcodec
			mi.AudioCodec = s.pi.acodec
			mi.Width = s.pi.width
			mi.Height = s.pi.height
		}
	}
	return mi
}

// ------------------------------------------------------------- stage plan

// stage is one ffmpeg invocation. progress reported inside the stage (0..1) is
// mapped onto the overall job progress using the stage weight.
type stage struct {
	label  string
	args   []string
	target float64 // duration in seconds used to compute in-stage progress
	weight float64 // share of the overall progress bar

	// fallback, when set, is used if the stage fails (e.g. the concat demuxer
	// run asked for a stream copy but the files turned out to be incompatible).
	fallback func() stage
}

type plan struct {
	stages []stage

	video         string
	audio         string
	videoDur      float64
	audioDur      float64
	videoHasAudio bool
	videoEncoded  bool // prepared video is already re-encoded (merge must copy)

	intermediates []string
}

func (m *manager) planJob(j *job, o options, vs, as []source) (plan, error) {
	p := plan{
		video:    vs[0].path,
		audio:    as[0].path,
		videoDur: sumDur(vs),
		audioDur: sumDur(as),
	}
	p.videoHasAudio = vs[0].pi.hasAudio

	// ---- join multiple videos -------------------------------------------------
	if len(vs) > 1 {
		out := filepath.Join(j.dir, "joined-video.mkv")
		// Clips' own audio is only needed in mix mode (and only if any clip has
		// some). Otherwise the joined video is video-only, so the concat demuxer
		// can stream-copy as long as the video parameters match.
		keepAudio := o.Mode == "mix" && anyHasAudio(vs)
		copyable := sameVideoParams(vs) && (!keepAudio || uniformAudioLayout(vs))

		filterStage := func() stage { return m.videoConcatFilterStage(j, vs, out, o, p.videoDur) }

		if copyable {
			list, err := writeConcatList(j.dir, "concat-video.txt", vs)
			if err != nil {
				return p, err
			}
			args := []string{
				"-hide_banner", "-nostdin", "-y",
				"-f", "concat", "-safe", "0", "-i", list,
				"-c", "copy", "-fflags", "+genpts", "-avoid_negative_ts", "make_zero",
			}
			if !keepAudio {
				args = append(args, "-map", "0:v:0") // drop clip audio, it is unused
			}
			args = append(args, progressFlags()...)
			args = append(args, "-f", "matroska", out)

			p.stages = append(p.stages, stage{
				label:    fmt.Sprintf("joining %d video clips", len(vs)),
				args:     args,
				target:   p.videoDur,
				weight:   0.1 * durWeight(p.videoDur),
				fallback: filterStage,
			})
			p.videoHasAudio = keepAudio
		} else {
			p.stages = append(p.stages, filterStage())
			// The filter stage re-encodes the video, so the merge can copy it.
			p.videoEncoded = true
			p.videoHasAudio = o.Mode == "mix" && anyHasAudio(vs)
		}
		p.video = out
		p.intermediates = append(p.intermediates, out)
	}

	// ---- join multiple audio files -------------------------------------------
	if len(as) > 1 {
		out := filepath.Join(j.dir, "joined-audio.mkv")
		filterStage := func() stage { return audioConcatFilterStage(as, out, p.audioDur) }

		if sameAudioParams(as) {
			list, err := writeConcatList(j.dir, "concat-audio.txt", as)
			if err != nil {
				return p, err
			}
			p.stages = append(p.stages, stage{
				label: fmt.Sprintf("joining %d audio files", len(as)),
				args: append([]string{
					"-hide_banner", "-nostdin", "-y",
					"-f", "concat", "-safe", "0", "-i", list,
					"-c", "copy", "-fflags", "+genpts", "-avoid_negative_ts", "make_zero",
				}, append(progressFlags(), "-f", "matroska", out)...),
				target:   p.audioDur,
				weight:   0.1 * durWeight(p.audioDur),
				fallback: filterStage,
			})
		} else {
			p.stages = append(p.stages, filterStage())
		}
		p.audio = out
		p.intermediates = append(p.intermediates, out)
	}

	// ---- final merge ---------------------------------------------------------
	target := p.videoDur
	if o.Shortest && p.audioDur > 0 {
		target = min(p.videoDur, p.audioDur)
	}
	encodeVideo := o.VideoCodec == "x264" && !p.videoEncoded

	weight := 0.3 * durWeight(target)
	if encodeVideo {
		weight = 1.0 * durWeight(target)
	}

	p.stages = append(p.stages, stage{
		label:  "merging video + audio",
		args:   mergeArgs(p.video, p.audio, j.outputPath, o, encodeVideo, p.videoHasAudio),
		target: target,
		weight: weight,
	})
	return p, nil
}

// videoConcatFilterStage joins clips with the concat filter (re-encodes video).
// In mix mode the clips' own audio is kept as well; silent clips get a matching
// stretch of silence so every segment has an audio track.
func (m *manager) videoConcatFilterStage(j *job, vs []source, out string, o options, totalDur float64) stage {
	// Only keep/fill the clips' audio when it is actually going to be mixed.
	wantAudio := o.Mode == "mix" && anyHasAudio(vs)
	first := vs[0].pi
	w, h := first.width, first.height
	if w == 0 || h == 0 {
		w, h = 640, 360
	}
	fps := frameRateValue(first.framerate)

	var args []string
	args = append(args, "-hide_banner", "-nostdin", "-y")

	for _, s := range vs {
		args = append(args, "-i", s.path)
	}

	audioRef := make([]string, len(vs))
	nextInput := len(vs)
	silentFilled := false
	if wantAudio {
		for i, s := range vs {
			if s.pi.hasAudio {
				audioRef[i] = fmt.Sprintf("[%d:a]", i)
				continue
			}
			// A silent clip: feed matching silence so every segment has audio.
			args = append(args, "-f", "lavfi", "-t", fmt.Sprintf("%.3f", durWeight(s.pi.duration)+0.5),
				"-i", "anullsrc=channel_layout=stereo:sample_rate=48000")
			audioRef[i] = fmt.Sprintf("[%d:a]", nextInput)
			nextInput++
			silentFilled = true
		}
		if silentFilled {
			j.addLog("note: some clips have no audio track - silence was inserted so the tracks could be joined")
		}
	}

	var filters, seq []string
	for i := range vs {
		filters = append(filters, fmt.Sprintf(
			"[%d:v]scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=%s[v%d]",
			i, w, h, w, h, fps, i))
		seq = append(seq, fmt.Sprintf("[v%d]", i))
		if wantAudio {
			filters = append(filters, fmt.Sprintf(
				"%saresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a%d]",
				audioRef[i], i))
			seq = append(seq, fmt.Sprintf("[a%d]", i))
		}
	}

	// concat expects the streams of each segment grouped together: v0 a0 v1 a1 …
	labels := "[vout]"
	audioFlag := 0
	if wantAudio {
		labels = "[vout][aout]"
		audioFlag = 1
	}
	graph := strings.Join(filters, ";") + ";" +
		strings.Join(seq, "") + fmt.Sprintf("concat=n=%d:v=1:a=%d%s", len(vs), audioFlag, labels)

	args = append(args, "-filter_complex", graph, "-map", "[vout]")
	if wantAudio {
		args = append(args, "-map", "[aout]")
	}
	args = append(args,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p")
	if wantAudio {
		args = append(args, "-c:a", "aac", "-b:a", "192k")
	}
	args = append(args, progressFlags()...)
	args = append(args, "-f", "matroska", out)

	return stage{
		label:  fmt.Sprintf("joining %d video clips (re-encoding)", len(vs)),
		args:   args,
		target: totalDur,
		weight: durWeight(totalDur),
	}
}

func audioConcatFilterStage(as []source, out string, totalDur float64) stage {
	args := []string{"-hide_banner", "-nostdin", "-y"}
	for _, s := range as {
		args = append(args, "-i", s.path)
	}
	var filters, seq []string
	for i := range as {
		filters = append(filters, fmt.Sprintf(
			"[%d:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a%d]", i, i))
		seq = append(seq, fmt.Sprintf("[a%d]", i))
	}
	graph := strings.Join(filters, ";") + ";" +
		strings.Join(seq, "") + fmt.Sprintf("concat=n=%d:v=0:a=1[aout]", len(as))

	args = append(args, "-filter_complex", graph, "-map", "[aout]",
		"-c:a", "aac", "-b:a", "192k")
	args = append(args, progressFlags()...)
	args = append(args, "-f", "matroska", out)

	return stage{
		label:  fmt.Sprintf("joining %d audio files", len(as)),
		args:   args,
		target: totalDur,
		weight: 0.25 * durWeight(totalDur),
	}
}

// progressFlags make ffmpeg report machine-readable progress on stdout and
// keep stderr limited to warnings and errors.
func progressFlags() []string {
	return []string{"-progress", "pipe:1", "-nostats", "-loglevel", "warning"}
}

// mergeArgs builds the final video+audio mux command.
func mergeArgs(videoPath, audioPath, out string, o options, encodeVideo, videoHasAudio bool) []string {
	mix := o.Mode == "mix" && videoHasAudio

	args := []string{"-hide_banner", "-nostdin", "-y", "-i", videoPath, "-i", audioPath}

	if mix {
		// When "trim to shortest" is on, the mixed track ends with the shorter
		// audio input so that -shortest also trims the video to that length.
		duration := "longest"
		if o.Shortest {
			duration = "shortest"
		}
		filter := fmt.Sprintf(
			"[1:a]volume=%.3f[music];[0:a][music]amix=inputs=2:duration=%s:dropout_transition=0:normalize=0[aout]",
			o.MixVolume, duration)
		args = append(args, "-filter_complex", filter, "-map", "0:v:0", "-map", "[aout]")
	} else {
		args = append(args, "-map", "0:v:0", "-map", "1:a:0")
	}

	if encodeVideo {
		args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p")
	} else {
		args = append(args, "-c:v", "copy")
	}

	if mix || o.AudioCodec != "copy" {
		args = append(args, "-c:a", "aac", "-b:a", o.AudioBitrate)
	} else {
		args = append(args, "-c:a", "copy")
	}

	if o.Shortest {
		args = append(args, "-shortest")
	}
	if o.Container == "mp4" {
		args = append(args, "-movflags", "+faststart")
	}

	args = append(args,
		"-progress", "pipe:1",
		"-nostats",
		"-loglevel", "warning",
		out)
	return args
}

func sameVideoParams(vs []source) bool {
	a := vs[0].pi
	for _, s := range vs[1:] {
		b := s.pi
		if a.vcodec != b.vcodec || a.pixfmt != b.pixfmt || a.width != b.width ||
			a.height != b.height || a.framerate != b.framerate {
			return false
		}
	}
	return true
}

func sameAudioParams(as []source) bool {
	a := as[0].pi
	for _, s := range as[1:] {
		b := s.pi
		if a.acodec != b.acodec || a.sampleRate != b.sampleRate || a.channels != b.channels {
			return false
		}
	}
	return true
}

func allHaveAudio(vs []source) bool {
	for _, s := range vs {
		if !s.pi.hasAudio {
			return false
		}
	}
	return true
}

func anyHasAudio(vs []source) bool {
	for _, s := range vs {
		if s.pi.hasAudio {
			return true
		}
	}
	return false
}

func noneHasAudio(vs []source) bool {
	for _, s := range vs {
		if s.pi.hasAudio {
			return false
		}
	}
	return true
}

// uniformAudioLayout reports whether all clips have the same audio layout:
// either nobody has audio, or everybody has audio with matching parameters.
// Needed because the concat demuxer copies every stream.
func uniformAudioLayout(vs []source) bool {
	if noneHasAudio(vs) {
		return true
	}
	if !allHaveAudio(vs) {
		return false
	}
	return sameAudioParams(vs)
}

func sumDur(ss []source) float64 {
	total := 0.0
	for _, s := range ss {
		total += s.pi.duration
	}
	return total
}

// durWeight keeps zero/unknown durations from collapsing the progress bar.
func durWeight(d float64) float64 {
	if d <= 0 {
		return 1
	}
	return d
}

func writeConcatList(dir, name string, ss []source) (string, error) {
	var b strings.Builder
	for _, s := range ss {
		// paths are generated by us, but escape anyway
		fmt.Fprintf(&b, "file '%s'\n", strings.ReplaceAll(s.path, "'", `'\''`))
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func frameRateValue(r string) string {
	if r == "" || r == "0/0" {
		return "30"
	}
	return r
}

// ---------------------------------------------------------- ffmpeg running

func scanFFmpegProgress(r io.Reader, targetSec float64, report func(float64), j *job) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		key, val, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		switch key {
		case "out_time_us", "out_time_ms": // ffmpeg reports microseconds for both keys
			if targetSec <= 0 {
				continue
			}
			us, err := strconv.ParseInt(val, 10, 64)
			if err != nil || us < 0 {
				continue
			}
			report(float64(us) / 1e6 / targetSec)
		case "speed":
			j.setSpeed(val)
		}
	}
}

func drainStderr(r io.Reader, j *job) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		j.addLog(sc.Text())
	}
}

func (m *manager) execFFmpeg(ctx context.Context, j *job, st stage, report func(float64)) error {
	log.Printf("job %s: [%s] %s %s", j.id, st.label, m.ffmpeg, strings.Join(st.args, " "))

	cmd := exec.CommandContext(ctx, m.ffmpeg, st.args...)
	cmd.Cancel = func() error { return cmd.Process.Kill() }

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); scanFFmpegProgress(stdout, st.target, report, j) }()
	go func() { defer wg.Done(); drainStderr(stderr, j) }()

	waitErr := cmd.Wait()
	wg.Wait()

	if ctx.Err() != nil {
		return ctx.Err()
	}
	if waitErr != nil {
		return errors.New(lastLog(j))
	}
	return nil
}

func (m *manager) execFail(j *job, err error) {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		j.fail("merge timed out after %s", m.jobTimeout)
	case errors.Is(err, context.Canceled):
		j.fail("merge was cancelled")
	default:
		j.fail("ffmpeg failed: %v", err)
	}
}

func (m *manager) run(j *job, o options) {
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), m.jobTimeout)
	defer cancel()

	j.mu.Lock()
	j.status = statusRunning
	j.started = started
	j.cancel = cancel
	j.mu.Unlock()

	defer func() {
		j.mu.Lock()
		if j.finished.IsZero() {
			j.finished = time.Now()
		}
		if j.status == statusRunning {
			j.status = statusError
			if j.errMsg == "" {
				j.errMsg = "merge ended unexpectedly"
			}
		}
		j.mu.Unlock()
	}()

	// ---- inputs are already probed and sorted by the upload handler -------
	vs := make([]source, 0, len(j.files))
	as := make([]source, 0, len(j.files))
	for _, f := range j.files {
		s := source{path: f.path, name: f.name, pi: f.pi}
		if f.kind == "video" {
			vs = append(vs, s)
		} else {
			as = append(as, s)
		}
	}

	// ---- build the stage pipeline -------------------------------------------
	pl, err := m.planJob(j, o, vs, as)
	if err != nil {
		j.fail("could not prepare the merge: %v", err)
		return
	}

	j.mu.Lock()
	j.videoInfo.HasAudio = pl.videoHasAudio
	j.mu.Unlock()

	if o.Mode == "mix" && !pl.videoHasAudio {
		j.addLog("note: the video has no usable audio track, so the dropped audio was used directly")
	}

	total := 0.0
	for _, s := range pl.stages {
		total += s.weight
	}
	if total <= 0 {
		total = 1
	}
	completed := 0.0

	for _, s := range pl.stages {
		st := s
		report := func(p float64) {
			if p < 0 {
				p = 0
			}
			if p > 0.995 {
				p = 0.995
			}
			j.setProgress((completed + p*st.weight) / total * 100)
		}
		j.setStage(st.label)

		err := m.execFFmpeg(ctx, j, st, report)
		if err != nil && st.fallback != nil && ctx.Err() == nil {
			j.addLog("note: " + st.label + " needed re-encoding after all")
			st = st.fallback()
			total += st.weight - s.weight
			j.setStage(st.label)
			err = m.execFFmpeg(ctx, j, st, report)
		}
		if err != nil {
			m.execFail(j, err)
			return
		}
		completed += st.weight
	}

	// ---- verify output ------------------------------------------------------
	out, err := os.Stat(j.outputPath)
	if err != nil || out.Size() == 0 {
		j.fail("ffmpeg finished but produced no output file")
		return
	}

	for _, f := range pl.intermediates {
		os.Remove(f)
	}

	j.mu.Lock()
	j.status = statusDone
	j.progress = 100
	j.stage = ""
	j.speed = ""
	j.finished = time.Now()
	j.mu.Unlock()
	log.Printf("job %s: done in %s (%s)", j.id, time.Since(started).Round(time.Millisecond), humanSize(out.Size()))
}

func lastLog(j *job) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.logs) == 0 {
		return "no details available"
	}
	// Prefer the last line that looks like an error.
	for i := len(j.logs) - 1; i >= 0; i-- {
		l := j.logs[i]
		if strings.Contains(l, "Error") || strings.Contains(l, "error") || strings.Contains(l, "Invalid") || strings.Contains(l, "failed") {
			return l
		}
	}
	return j.logs[len(j.logs)-1]
}

// --------------------------------------------------------------- HTTP layer

func (m *manager) handleCreate(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		writeErr(w, http.StatusBadRequest, "request must be multipart/form-data")
		return
	}

	j, err := m.newJob()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create job: "+err.Error())
		return
	}

	o := defaultOptions()
	var totalBytes int64
	var anyEmpty bool
	counts := map[string]int{"video": 0, "audio": 0}

	abort := func(code int, msg string) {
		m.discard(j)
		writeJSON(w, code, map[string]any{"error": msg, "files": fileViews(j.files)})
	}

	r.Body = http.MaxBytesReader(w, r.Body, m.maxUpload)
	mr, err := r.MultipartReader()
	if err != nil {
		abort(http.StatusBadRequest, "could not read upload: "+err.Error())
		return
	}

	savePart := func(part io.Reader, name string) (string, int64, error) {
		path := filepath.Join(j.dir, name)
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return "", 0, err
		}
		defer f.Close()
		n, err := io.Copy(f, part)
		if err != nil {
			return "", n, err
		}
		return path, n, nil
	}

	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			abort(uploadErrCode(err), "upload failed: "+uploadErrMsg(err))
			return
		}

		if part.FileName() == "" { // plain form field with the options
			val, _ := io.ReadAll(io.LimitReader(part, 64<<10))
			applyField(&o, part.FormName(), strings.TrimSpace(string(val)))
			continue
		}

		switch part.FormName() {
		case "video", "audio":
			kind := part.FormName()
			if counts[kind] >= maxFilesPerKind {
				abort(http.StatusBadRequest, fmt.Sprintf("too many %s files (limit %d)", kind, maxFilesPerKind))
				return
			}
			// The extension on disk is cosmetic (unknown ones become .bin);
			// ffprobe and ffmpeg decide what the file really is.
			ext := safeExt(part.FileName(), kind == "audio")
			name := fmt.Sprintf("input-%s-%d%s", kind, counts[kind]+1, ext)
			path, n, err := savePart(part, name)
			if err != nil {
				abort(uploadErrCode(err), "could not store the "+kind+" file: "+uploadErrMsg(err))
				return
			}
			counts[kind]++
			anyEmpty = anyEmpty || n == 0
			totalBytes += n
			j.files = append(j.files, inputFile{
				path:     path,
				name:     filepath.Base(part.FileName()),
				declared: kind,
			})
		default:
			io.Copy(io.Discard, part)
		}
	}

	if len(j.files) == 0 {
		abort(http.StatusBadRequest, "no files were uploaded")
		return
	}
	if anyEmpty {
		abort(http.StatusBadRequest, "one of the uploaded files is empty")
		return
	}

	// ---- sort every file by what it really contains --------------------------
	// Extensions and file names are ignored: a video called "stream.mp3" is a
	// video, an audio-only file dropped on the video side moves to the audio
	// side. Files that contain both keep the side they were dropped on. The
	// result is reported back so the web UI can show every file in its proper
	// list.
	classified := make([]inputFile, len(j.files))
	for i, f := range j.files {
		pi, err := probeFile(m.ffprobe, f.path)
		if err != nil {
			j.files = append(classified[:i:i], j.files[i:]...)
			abort(http.StatusBadRequest, fmt.Sprintf("could not read %q: %v", f.name, err))
			return
		}
		f.pi = pi
		switch {
		case pi.hasVideo && pi.hasAudio:
			// Usable as either side, so respect where the user dropped it.
			f.kind = f.declared
		case pi.hasVideo:
			f.kind = "video"
			if f.declared == "audio" {
				j.addLog(fmt.Sprintf("note: %q was dropped as audio but has no audio track - used as a video instead", f.name))
			}
		case pi.hasAudio:
			f.kind = "audio"
			if f.declared == "video" {
				j.addLog(fmt.Sprintf("note: %q was dropped as video but has no video stream - used as audio instead", f.name))
			}
		default:
			j.files = append(classified[:i:i], j.files[i:]...)
			abort(http.StatusBadRequest, fmt.Sprintf("%q contains no audio or video stream - it does not look like a media file", f.name))
			return
		}
		classified[i] = f
	}
	j.files = classified

	vs := make([]source, 0, len(j.files))
	as := make([]source, 0, len(j.files))
	for _, f := range j.files {
		s := source{path: f.path, name: f.name, pi: f.pi}
		if f.kind == "video" {
			vs = append(vs, s)
		} else {
			as = append(as, s)
		}
	}
	if len(vs) == 0 {
		abort(http.StatusBadRequest, "no video found - add at least one file that contains a video stream")
		return
	}
	if len(as) == 0 {
		abort(http.StatusBadRequest, "no audio found - add at least one audio file (or a video that has an audio track)")
		return
	}
	j.videoInfo = aggregate(vs)
	j.audioInfo = aggregate(as)

	o.sanitize()
	if o.Container == "mp4" {
		j.outputName = fmt.Sprintf("merged-%s.mp4", j.id[:8])
	} else {
		j.outputName = fmt.Sprintf("merged-%s.mkv", j.id[:8])
	}
	j.outputPath = filepath.Join(j.dir, j.outputName)

	log.Printf("job %s: upload complete (%d video, %d audio by content; %s total), mode=%s video=%s audio=%s/%s container=%s shortest=%v",
		j.id, len(vs), len(as), humanSize(totalBytes),
		o.Mode, o.VideoCodec, o.AudioCodec, o.AudioBitrate, o.Container, o.Shortest)

	m.register(j)
	go m.run(j, o)
	writeJSON(w, http.StatusAccepted, j.view())
}

func (m *manager) handleStatus(w http.ResponseWriter, r *http.Request) {
	j := m.get(r.PathValue("id"))
	if j == nil {
		writeErr(w, http.StatusNotFound, "unknown job")
		return
	}
	writeJSON(w, http.StatusOK, j.view())
}

func (m *manager) handleFile(w http.ResponseWriter, r *http.Request) {
	j := m.get(r.PathValue("id"))
	if j == nil {
		writeErr(w, http.StatusNotFound, "unknown job")
		return
	}
	j.mu.Lock()
	path, name, status := j.outputPath, j.outputName, j.status
	j.mu.Unlock()

	if status != statusDone {
		writeErr(w, http.StatusConflict, "the merged file is not ready yet")
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, path)
}

func (m *manager) handleDelete(w http.ResponseWriter, r *http.Request) {
	m.remove(r.PathValue("id"))
	w.WriteHeader(http.StatusNoContent)
}

func (m *manager) handleHealth(w http.ResponseWriter, r *http.Request) {
	ok := true
	ver := ""
	out, err := exec.Command(m.ffmpeg, "-version").Output()
	if err != nil {
		ok = false
	} else if line, _, _ := strings.Cut(string(out), "\n"); line != "" {
		ver = line
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     ok,
		"ffmpeg": ver,
		"engine": "ffmpeg",
	})
}

// -------------------------------------------------------------- small utils

var videoExts = map[string]bool{
	".mp4": true, ".m4v": true, ".mov": true, ".mkv": true, ".webm": true,
	".avi": true, ".ts": true, ".mts": true, ".m2ts": true, ".mpg": true,
	".mpeg": true, ".flv": true, ".wmv": true, ".3gp": true, ".ogv": true,
}

var audioExts = map[string]bool{
	".mp3": true, ".m4a": true, ".aac": true, ".wav": true, ".flac": true,
	".ogg": true, ".oga": true, ".opus": true, ".wma": true, ".mka": true,
	".aiff": true, ".aif": true, ".alac": true, ".ac3": true,
}

// safeExt returns a cleaned extension so ffmpeg and browsers see the right type.
// The extension is only cosmetic: ffmpeg probes the actual content.
func safeExt(name string, audio bool) string {
	ext := strings.ToLower(filepath.Ext(name))
	if audio {
		if audioExts[ext] {
			return ext
		}
		return ".bin"
	}
	if videoExts[ext] {
		return ext
	}
	return ".bin"
}

func randomID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func firstLine(s string) string {
	if line, _, _ := strings.Cut(s, "\n"); line != "" {
		return strings.TrimSpace(line)
	}
	return strings.TrimSpace(s)
}

func humanSize(n int64) string {
	const unit = 1000
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for n/div >= unit && exp < 4 {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGT"[exp])
}

func uploadErrCode(err error) int {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}

func uploadErrMsg(err error) string {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		return fmt.Sprintf("upload exceeds the limit of %s", humanSize(mbe.Limit))
	}
	return err.Error()
}

// parseSize understands plain bytes, or values like "8GB", "500MiB", "2g".
func parseSize(s string) (int64, error) {
	s = strings.TrimSpace(strings.ToUpper(s))
	if s == "" {
		return 0, errors.New("empty size")
	}
	mult := int64(1)
	for _, suf := range []struct {
		s string
		m int64
	}{
		{"KIB", 1 << 10}, {"MIB", 1 << 20}, {"GIB", 1 << 30}, {"TIB", 1 << 40},
		{"KB", 1000}, {"MB", 1000 * 1000}, {"GB", 1000 * 1000 * 1000}, {"TB", 1000 * 1000 * 1000 * 1000},
		{"K", 1 << 10}, {"M", 1 << 20}, {"G", 1 << 30}, {"T", 1 << 40},
		{"B", 1},
	} {
		if strings.HasSuffix(s, suf.s) {
			mult = suf.m
			s = strings.TrimSuffix(s, suf.s)
			break
		}
	}
	n, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, fmt.Errorf("invalid size %q", s)
	}
	return int64(n * float64(mult)), nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// ------------------------------------------------------------------- main

func main() {
	var (
		addr       = flag.String("addr", ":8080", "address the web server listens on")
		tmpDir     = flag.String("tmp", "", "directory for temporary job files (default: system temp dir)")
		ttl        = flag.Duration("ttl", 2*time.Hour, "how long finished results are kept before cleanup")
		maxUpload  = flag.String("max-upload", "8GB", "maximum combined upload size per job")
		jobTimeout = flag.Duration("job-timeout", 2*time.Hour, "maximum time a single ffmpeg merge may run")
		ffmpegBin  = flag.String("ffmpeg", "ffmpeg", "path to the ffmpeg binary")
		ffprobeBin = flag.String("ffprobe", "ffprobe", "path to the ffprobe binary")
		openUI     = flag.Bool("open", false, "open the web UI in the default browser on start")
	)
	flag.Parse()

	maxBytes, err := parseSize(*maxUpload)
	if err != nil {
		log.Fatalf("invalid -max-upload: %v", err)
	}

	root := *tmpDir
	ownRoot := false
	if root == "" {
		root, err = os.MkdirTemp("", "videojoin-")
		if err != nil {
			log.Fatalf("could not create temp dir: %v", err)
		}
		ownRoot = true
	} else {
		if err := os.MkdirAll(root, 0o755); err != nil {
			log.Fatalf("could not create temp dir %s: %v", root, err)
		}
	}

	if out, err := exec.Command(*ffmpegBin, "-version").Output(); err != nil {
		log.Printf("WARNING: %s not found (%v) - merging will fail until ffmpeg is installed", *ffmpegBin, err)
	} else {
		log.Printf("%s", firstLine(string(out)))
	}

	mgr := newManager(root, ownRoot, *ttl, maxBytes, *jobTimeout, *ffmpegBin, *ffprobeBin)
	mgr.cleanupStaleDirs()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go mgr.janitor(ctx)

	webRoot, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("could not load embedded web assets: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/jobs", mgr.handleCreate)
	mux.HandleFunc("GET /api/jobs/{id}", mgr.handleStatus)
	mux.HandleFunc("GET /api/jobs/{id}/file", mgr.handleFile)
	mux.HandleFunc("DELETE /api/jobs/{id}", mgr.handleDelete)
	mux.HandleFunc("GET /api/health", mgr.handleHealth)
	mux.Handle("/", http.FileServerFS(webRoot))

	srv := &http.Server{
		Addr:         *addr,
		Handler:      logRequests(mux),
		IdleTimeout:  2 * time.Minute,
		ReadTimeout:  0, // uploads can be large
		WriteTimeout: 0, // downloads can be large
	}

	url := "http://localhost" + *addr
	if strings.HasPrefix(*addr, "0.0.0.0:") {
		url = "http://localhost:" + strings.TrimPrefix(*addr, "0.0.0.0:")
	}

	if *openUI {
		go func() {
			time.Sleep(300 * time.Millisecond)
			_ = exec.Command("open", url).Start()
		}()
	}

	go func() {
		log.Printf("videojoin listening on %s (temp dir: %s)", url, root)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("shutting down...")
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	_ = srv.Shutdown(shutdownCtx)
	mgr.close()
	log.Printf("bye")
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only log API traffic: static files would be noisy.
		if strings.HasPrefix(r.URL.Path, "/api/") {
			start := time.Now()
			next.ServeHTTP(w, r)
			log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
			return
		}
		next.ServeHTTP(w, r)
	})
}
