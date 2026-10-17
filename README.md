# videojoin — drop videos + audio, get them joined and merged

A tiny self-contained Go server with a web UI. Drag one or more videos and one
or more audio files into the browser, the server joins them with **ffmpeg** and
gives you a download link for the result. Nothing is uploaded to a third party
and no database is involved — files live in a temp directory per job and are
deleted after the TTL (2 h by default) or on shutdown.

```
┌────────────┐   multipart POST   ┌──────────────────────────────────┐
│  browser   │ ─────────────────▶ │ Go server                        │
│  (web UI)  │                    │  ffprobe → join clips/tracks →   │
│            │ ◀───── poll ────── │  merge video+audio → temp dir    │
│            │ ◀── GET .../file ─ │  streamed download               │
└────────────┘                    └──────────────────────────────────┘
```

With several files the pipeline runs in up to three stages, and the progress
bar spans all of them:

1. **Join the videos** (in list order) — stream copy when the clips share the
   same codec parameters, otherwise re-encoded with the concat filter.
2. **Join the audio files** (in list order) — same idea for tracks.
3. **Merge** the joined video with the joined audio using your options.

## Requirements

- Go 1.22+ (uses `net/http` method patterns such as `POST /api/jobs`)
- `ffmpeg` and `ffprobe` on your `PATH` (or point at them with `-ffmpeg` / `-ffprobe`)

## Run

```sh
go run .            # http://localhost:8080
# or
go build -o videojoin . && ./videojoin -open
```

Open <http://localhost:8080>. The header shows whether ffmpeg was found.

### Browser-only version (WebAssembly)

The same app also exists as a server-less build on the
[`wasm` branch](https://github.com/mohitdhami/Video-Audio-Merger/tree/wasm):
ffmpeg runs inside the browser tab through
[ffmpeg.wasm](https://ffmpegwasm.netlify.app/) — nothing is uploaded anywhere
and no Go binary is needed. It trades the server's disk space and native speed
for pure in-tab processing (keep the total input under ~1 GB, and expect
single-threaded WASM speed for re-encoding). That branch is self-contained:
clone/browse it, run `./serve.sh` and open the page (deployable to any static
host as-is).

### Flags

| flag | default | meaning |
| --- | --- | --- |
| `-addr` | `:8080` | listen address |
| `-tmp` | system temp dir | where per-job temp directories are created |
| `-ttl` | `2h` | how long finished results are kept before cleanup |
| `-max-upload` | `8GB` | max combined upload size per job (accepts `500MB`, `8GiB`, …) |
| `-job-timeout` | `2h` | max runtime of a single ffmpeg merge |
| `-ffmpeg` | `ffmpeg` | path to the ffmpeg binary |
| `-ffprobe` | `ffprobe` | path to the ffprobe binary |
| `-open` | `false` | open the web UI in the default browser on start |

Example:

```sh
./videojoin -addr :9000 -tmp /var/tmp/videojoin -ttl 30m -max-upload 500MB -open
```

## What the UI lets you choose

- **Multiple files per side** — drop as many videos and/or audio files as you
  like into either zone (or both at once: mixed drops are split up right away —
  every file lands in the list matching its content, so both sections show their
  own files immediately). Items are joined in list order, so drag the rows to
  reorder them; you can also drag a row **across** to the other list to change
  what it is used for. Each row can be removed, and `+ add` / `clear` manage
  the list.
- **Any extension, no extension, wrong extension** — files are classified by
  what is actually inside them (ffprobe), never by their name:
  - The browser already peeks into each file on drop (container + stream
    headers), so mixed drops split into the video and audio lists instantly.
  - Right after the upload the server probes every file with ffprobe and reports
    the definitive classification back (`files`); if it disagrees with the
    initial guess, the rows move to their proper list before the merge runs.
  - `stream` (no extension) works, as does a video called `stream.mp3`.
  - An audio-only file dropped on the video side ends up on the audio side
    automatically (and vice versa) — the job log says so.
  - A file that contains *both* video and audio stays on the side you dropped
    it on: video side = use its picture, audio side = use its soundtrack.
    Drag the row to the other list to switch.
  - Embedded cover art (e.g. album art in an MP3) does **not** count as video.
  - The temporary filename on disk is only cosmetic: unknown extensions become
    `.bin` and ffmpeg still recognises the real format.
  - Unreadable files and uploads without a video (or without audio) are rejected
    immediately with a clear message, before anything starts encoding.
- **Audio handling** — *replace* the video's audio, or *mix* the dropped audio
  with the existing track; the added track is mixed in at 50% volume under the
  original (fixed default, API callers can still tune it with `mixVolume`).
- **Video stream** — stream copy (instant, lossless) or re-encode to H.264
  (rescues containers/codecs that MP4 can't hold).
- **Audio encoder / bitrate** — AAC at 128–320 kbps, or copy the original codec.
- **Container** — MP4 (with `+faststart`, plays while downloading) or MKV.
- **Trim to shortest input** — cut the result to the shorter of the two sides.

Progress is streamed live from `ffmpeg -progress`, including the current stage,
speed and an ETA. If something fails, the UI shows the important line of
ffmpeg's stderr plus a collapsible full log.

### How multiple files are joined

| situation | what happens |
| --- | --- |
| clips share codec, size, pixel format and frame rate | concat demuxer with `-c copy` — instant and lossless |
| clips differ in any of those | concat filter: scaled/padded to the first clip's frame size, `setsar=1`, frame rate normalised, re-encoded with H.264 (the final merge then copies) |
| *replace* mode | the clips' own audio is dropped while joining, so mixed audio layouts are fine |
| *mix* mode | the clips' audio is kept and joined; silent clips get matching silence inserted, so tracks line up |
| *mix* mode but no clip has audio | falls back to `replace` and says so in the log |
| audio files with matching codec/rate/channels | concat demuxer with `-c copy` |
| audio files that differ | re-encoded to AAC 48 kHz stereo while joining |

## HTTP API

| method & path | purpose |
| --- | --- |
| `POST /api/jobs` | multipart upload. File fields `video` and `audio` may be repeated (up to 20 each, **order is preserved**) and are only hints: the server inspects every file and uses it on the side matching its real content. Optional fields: `mode` (`replace`\|`mix`), `videoCodec` (`copy`\|`x264`), `audioCodec` (`aac`\|`copy`), `audioBitrate`, `container` (`mp4`\|`mkv`), `shortest` (`true`\|`false`), `mixVolume` (`0`–`2`). Returns `202` with the job JSON, or `400` with `{"error": …, "files": […]}` when a file is unreadable or the uploads contain no video (or no audio) — nothing is encoded in that case. |
| `GET /api/jobs/{id}` | job status: `status`, `progress` (0–100), `stage` (`joining 3 video clips`, `merging video + audio`, …), `speed`, `elapsedMs`, `files` (per-file `name` + `kind` as decided by content), aggregated probe info for both sides (`count`, summed `duration`/`size`), `error`, `log`. |
| `GET /api/jobs/{id}/file` | download the merged file (supports range requests). `409` until the job is done. |
| `DELETE /api/jobs/{id}` | cancel the job and remove its temp files immediately. |
| `GET /api/health` | `{"ok":true,"ffmpeg":"ffmpeg version …"}` |

Example with curl — join three clips and two tracks, then download:

```sh
id=$(curl -s \
       -F "video=@part1.mp4" -F "video=@part2.mp4" -F "video=@part3.mp4" \
       -F "audio=@song1.mp3" -F "audio=@song2.mp3" \
       -F mode=mix -F mixVolume=0.4 \
       http://localhost:8080/api/jobs | jq -r .id)
curl -s http://localhost:8080/api/jobs/$id | jq '{status, stage, progress, speed}'
curl -OJ http://localhost:8080/api/jobs/$id/file
```

## Layout

```
main.go            server: jobs, multi-file uploads, probe, join/merge stages, progress
web/index.html     UI markup (embedded into the binary via go:embed)
web/app.js         drag & drop lists (multi-file, reorderable), upload progress, polling, download
web/style.css      dark theme
```

Everything is in one binary; `web/` is embedded at build time.

## Notes

- Uploads are streamed straight to disk (`r.MultipartReader`), so large files
  never sit in memory. A single job may be up to `-max-upload` in total
  (default 8 GB) and 20 files per side.
- Each uploaded file is probed with ffprobe once, before the job is registered:
  the result (`files`) is sent to the UI and reused by the pipeline, so the
  lists and the merge always agree on which file is video and which is audio.
- Multi-file jobs use temporary intermediates (`joined-video.mkv`,
  `joined-audio.mkv`) that are removed as soon as the final merge succeeds;
  they are never downloaded and are cleaned up with the job directory.
- A single-file job runs exactly one ffmpeg command:
  `ffmpeg -y -i <video> -i <audio> -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac
  -shortest -movflags +faststart out.mp4` (adjusted for your chosen options);
  in mix mode it uses
  `amix=inputs=2:duration=shortest|longest:normalize=0` with a `volume` filter
  on the added track.
- ffmpeg's own error output is kept (last 60 lines) and shown in the UI, so
  odd formats are debuggable without reading server logs.
