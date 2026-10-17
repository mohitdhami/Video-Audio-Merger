"use strict";

/*
 * Browser-only version of videojoin: exactly the same drop/join/merge pipeline
 * as the Go server, but ffmpeg runs inside this page through ffmpeg.wasm.
 * No uploads, no server, no ffprobe: stream information is read from the
 * `ffmpeg -i` output instead.
 */

const $ = (sel) => document.querySelector(sel);

const state = {
  files: { video: [], audio: [] },
  pendingDetects: 0, // files whose contents are still being sniffed
  running: false,
  cancelled: false,
  jobId: null, // random id for the output file name
  engineReady: false,
  engineLogs: [],
  url: null, // object URL of the last result
};

const VIDEO_EXT = [".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".ts", ".mts",
  ".m2ts", ".mpg", ".mpeg", ".flv", ".wmv", ".3gp", ".ogv"];
const AUDIO_EXT = [".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".oga",
  ".opus", ".wma", ".mka", ".aiff", ".aif", ".alac", ".ac3"];

// ---------------------------------------------------------------- helpers

function humanBytes(n) {
  if (!n && n !== 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function humanDuration(sec) {
  if (!sec || sec <= 0) return "?";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const two = (x) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

function humanMs(ms) {
  if (!ms || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

function randomId() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function setBar(pct, indeterminate) {
  const bar = $("#bar");
  bar.classList.toggle("indeterminate", !!indeterminate);
  if (!indeterminate) $("#bar-fill").style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

let noteTimer = null;
function showNote(msg) {
  const el = $("#note");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

function showError(msg) {
  $("#errbox").hidden = false;
  $("#errbox").textContent = msg;
  $("#status-badge").textContent = "error";
  $("#status-badge").className = "badge error";
  $("#progress-text").textContent = "failed";
}

// ---------------------------------------------------------------- sniffing

// Figures out whether a file is a video or an audio file ("" when unsure).
function classify(file) {
  const type = (file.type || "").toLowerCase();
  const ext = extOf(file.name);
  if (type.startsWith("video/") || VIDEO_EXT.includes(ext)) return "video";
  if (type.startsWith("audio/") || AUDIO_EXT.includes(ext)) return "audio";
  return "";
}

// Extensions that reliably mean "audio" even though the container could hold
// video too (.m4a and .mka are really mp4/mkv, .wma is asf).
const STRONG_AUDIO_EXT = [".m4a", ".m4b", ".mka", ".wma", ".aif", ".aiff",
  ".alac", ".ac3", ".dts"];

function matchASCII(bytes, offset, str) {
  if (offset + str.length > bytes.length) return false;
  for (let i = 0; i < str.length; i++) {
    if (bytes[offset + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

// Looks at the first bytes of a file and guesses the *kind* of its content.
// Returns "video", "audio" or "" when the container alone does not tell.
async function sniffKind(file) {
  let bytes;
  try {
    bytes = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
  } catch (e) {
    return "";
  }
  if (bytes.length < 12) return "";

  if (matchASCII(bytes, 0, "fLaC")) return "audio";
  if (matchASCII(bytes, 0, "OggS")) return "audio";
  if (matchASCII(bytes, 0, "ID3")) return "audio";
  if (matchASCII(bytes, 0, "MThd")) return "audio";
  if (matchASCII(bytes, 0, "#!AMR")) return "audio";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio"; // mp3/aac frame
  if (matchASCII(bytes, 0, "RIFF")) {
    if (matchASCII(bytes, 8, "WAVE")) return "audio";
    if (matchASCII(bytes, 8, "AVI ")) return "video";
  }

  if (matchASCII(bytes, 4, "ftyp")) {
    let hasVideo = false, hasAudio = false;
    for (let i = 0; i + 16 <= bytes.length; i++) {
      if (bytes[i] === 0x68 && bytes[i + 1] === 0x64 && bytes[i + 2] === 0x6c && bytes[i + 3] === 0x72) { // "hdlr"
        const h = String.fromCharCode(bytes[i + 12], bytes[i + 13], bytes[i + 14], bytes[i + 15]);
        if (h === "vide") hasVideo = true;
        else if (h === "soun") hasAudio = true;
      }
    }
    if (hasVideo) return "video";
    if (hasAudio) return "audio";
    return "video"; // movie header not in the first chunk - default to video
  }

  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    let hasVideo = false, hasAudio = false;
    for (let i = 0; i + 3 <= bytes.length; i++) {
      if (bytes[i] === 0x83 && bytes[i + 1] === 0x81) {
        if (bytes[i + 2] === 1) hasVideo = true;
        else if (bytes[i + 2] === 2) hasAudio = true;
      }
    }
    if (hasVideo) return "video";
    if (hasAudio) return "audio";
    return "video";
  }

  if (bytes[0] === 0x47) return "video"; // MPEG-TS
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1) return "video"; // MPEG-PS/ES
  if (matchASCII(bytes, 0, "FLV")) return "video";
  if (bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xb2 && bytes[3] === 0x75) return "video"; // ASF
  return "";
}

// Decides which list a dropped file belongs in: mostly by what is inside it,
// with the extension as a backup.
async function detectKind(file) {
  if (STRONG_AUDIO_EXT.includes(extOf(file.name))) return "audio";
  const sniffed = await sniffKind(file);
  if (sniffed) return sniffed;
  return classify(file);
}

// ---------------------------------------------------------------- lists

// Adds dropped/selected files to the lists. A mixed drop - audio and video
// together on one zone - is split up: every file goes to the list matching its
// content, so both lists show their own files right away.
async function addFiles(kind, files) {
  const moved = { video: 0, audio: 0 };
  for (const f of files) {
    state.pendingDetects++;
    updateMergeButton();
    let detected = "";
    try {
      detected = await detectKind(f);
    } finally {
      state.pendingDetects--;
    }
    const target = detected || kind; // unknown types stay where they were dropped
    state.files[target].push(f);
    if (target !== kind) moved[target]++;
    renderZone("video");
    renderZone("audio");
  }

  const parts = [];
  if (moved.video) parts.push(`${moved.video} to the video list`);
  if (moved.audio) parts.push(`${moved.audio} to the audio list`);
  if (parts.length) {
    showNote(`detected by content: ${parts.join(" and ")}.`);
  }
  updateMergeButton();
}

function renderZone(kind) {
  const files = state.files[kind];
  const list = kind === "video" ? $("#list-video") : $("#list-audio");
  const empty = (kind === "video" ? $("#zone-video") : $("#zone-audio")).querySelector(".dz-empty");
  const foot = kind === "video" ? $("#foot-video") : $("#foot-audio");
  const total = kind === "video" ? $("#total-video") : $("#total-audio");

  list.innerHTML = "";
  files.forEach((f, i) => list.appendChild(fileRow(kind, f, i)));

  const has = files.length > 0;
  list.hidden = !has;
  foot.hidden = !has;
  empty.hidden = has;
  (kind === "video" ? $("#zone-video") : $("#zone-audio")).classList.toggle("filled", has);

  const bytes = files.reduce((a, f) => a + f.size, 0);
  total.textContent = `${files.length} file${files.length > 1 ? "s" : ""} · ${humanBytes(bytes)}`;

  updateMergeButton();
}

function fileRow(kind, file, index) {
  const li = document.createElement("li");
  li.className = "file-row";
  li.draggable = true;
  li.dataset.index = String(index);

  const grip = document.createElement("span");
  grip.className = "grip";
  grip.textContent = "⠿";
  grip.title = "drag to reorder";

  const name = document.createElement("span");
  name.className = "fname";
  name.textContent = file.name;
  name.title = file.name;

  const size = document.createElement("span");
  size.className = "fsize";
  size.textContent = humanBytes(file.size);

  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "rm";
  rm.textContent = "×";
  rm.title = "remove";
  rm.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.files[kind].splice(index, 1);
    renderZone(kind);
  });

  li.append(grip, name, size, rm);

  // ---- reordering ------------------------------------------------------
  li.addEventListener("dragstart", (e) => {
    state.dragFrom = { kind, index };
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", String(index)); } catch (err) { /* ignore */ }
  });
  li.addEventListener("dragend", () => {
    state.dragFrom = null;
    li.classList.remove("dragging");
    document.querySelectorAll(".file-row.over").forEach((el) => el.classList.remove("over"));
  });
  li.addEventListener("dragover", (e) => {
    if (!state.dragFrom) return; // an OS file drag - the zone handles it
    e.preventDefault();
    e.stopPropagation();
    li.classList.add("over");
  });
  li.addEventListener("dragleave", () => li.classList.remove("over"));
  li.addEventListener("drop", (e) => {
    const from = state.dragFrom;
    if (!from) return; // OS file drops bubble up to the zone
    e.preventDefault();
    e.stopPropagation();
    li.classList.remove("over");
    moveFile(from.kind, from.index, kind, index);
  });

  return li;
}

// Moves a file within a list or between the video and audio lists.
function moveFile(fromKind, fromIndex, toKind, toIndex) {
  const src = state.files[fromKind];
  const file = src[fromIndex];
  state.dragFrom = null;
  if (!file) return;
  src.splice(fromIndex, 1);
  let to = toIndex;
  if (fromKind === toKind && fromIndex < toIndex) to -= 1;
  const dst = state.files[toKind];
  to = Math.max(0, Math.min(dst.length, to));
  dst.splice(to, 0, file);
  renderZone("video");
  renderZone("audio");
  if (fromKind !== toKind) {
    showNote(`"${file.name}" moved to the ${toKind} list.`);
  }
}

function updateMergeButton() {
  const nv = state.files.video.length;
  const na = state.files.audio.length;
  const btn = $("#merge");
  btn.disabled = nv === 0 || na === 0 || state.running || state.pendingDetects > 0 || !state.engineReady;
  const vTxt = `${nv} video${nv === 1 ? "" : "s"}`;
  const aTxt = `${na} audio${na === 1 ? "" : "s"}`;
  btn.textContent = nv || na ? `Merge ${vTxt} + ${aTxt}` : "Merge video + audio";
}

// ---------------------------------------------------------------- dropzones

function setupZone(kind, zoneSel, inputSel, addBtnSel, clearBtnSel) {
  const zone = $(zoneSel);
  const input = $(inputSel);

  const openPicker = () => input.click();

  zone.addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.closest(".file-row")) return;
    openPicker();
  });
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPicker();
    }
  });

  input.addEventListener("change", () => {
    if (input.files.length) addFiles(kind, Array.from(input.files));
    input.value = ""; // allow re-selecting the same file
  });

  $(addBtnSel).addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPicker();
  });
  $(clearBtnSel).addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.files[kind] = [];
    renderZone(kind);
  });

  ["dragenter", "dragover"].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      if (state.dragFrom) return; // internal reordering, not a file drop
      zone.classList.add("drag");
    })
  );
  ["dragleave", "dragend"].forEach((ev) =>
    zone.addEventListener(ev, () => zone.classList.remove("drag"))
  );
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    if (state.dragFrom) {
      moveFile(state.dragFrom.kind, state.dragFrom.index, kind, state.files[kind].length);
      return;
    }
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) addFiles(kind, Array.from(files));
  });
}

setupZone("video", "#zone-video", "#file-video", "#add-video", "#clear-video");
setupZone("audio", "#zone-audio", "#file-audio", "#add-audio", "#clear-audio");

document.addEventListener("dragend", () => {
  state.dragFrom = null;
  document.querySelectorAll(".file-row.over").forEach((el) => el.classList.remove("over"));
});

// ---------------------------------------------------------------- options

$("#mode").addEventListener("change", () => {
  const mixing = $("#mode").value === "mix";
  // Mixing requires re-encoding the audio, so "copy" is not an option there.
  const copyOpt = $('#audioCodec option[value="copy"]');
  copyOpt.disabled = mixing;
  if (mixing && $("#audioCodec").value === "copy") $("#audioCodec").value = "aac";
});

function readOptions() {
  return {
    mode: $("#mode").value,
    videoCodec: $("#videoCodec").value,
    audioCodec: $("#audioCodec").value,
    audioBitrate: $("#audioBitrate").value,
    container: $("#container").value,
    shortest: $("#shortest").checked,
    mixVolume: 0.5, // fixed default, as on the server
  };
}

// ---------------------------------------------------------------- ffmpeg engine

let ff = null; // the FFmpegWASM.FFmpeg instance
let logTarget = null; // temporary collector used while probing

async function loadEngine() {
  ff = new FFmpegWASM.FFmpeg();
  ff.on("log", ({ message }) => {
    state.engineLogs.push(message);
    if (state.engineLogs.length > 400) state.engineLogs.shift();
    if (logTarget) logTarget.push(message);
  });
  ff.on("progress", ({ time }) => {
    hookProgress(time);
  });
  // Absolute URLs: the ffmpeg worker resolves relative paths against its own
  // location (vendor/), not the page.
  await ff.load({
    coreURL: new URL("core/ffmpeg-core.js", document.baseURI).href,
    wasmURL: new URL("core/ffmpeg-core.wasm", document.baseURI).href,
  });
  state.engineReady = true;
  updateMergeButton();
}

loadEngine()
  .then(() => {
    const el = $("#health");
    el.textContent = "ffmpeg ready · on-device";
    el.classList.add("ok");
    el.title = "ffmpeg is running inside this browser tab (WebAssembly)";
  })
  .catch((err) => {
    const el = $("#health");
    el.textContent = "ffmpeg failed to load";
    el.classList.add("bad");
    el.title = String(err && err.message ? err.message : err);
    showError(`could not load the ffmpeg core: ${err && err.message ? err.message : err}`);
  });

// ---------------------------------------------------------------- probing

const LAYOUT_CHANNELS = {
  mono: 1, stereo: 2, quad: 4, hexagonal: 6, octagonal: 8,
  "2.1": 3, "3.0": 3, "4.0": 4, "4.1": 5, "5.0": 5, "5.1": 6, "5.1(side)": 6,
  "6.1": 7, "7.1": 8, "7.1(wide)": 8,
};

// Parses the lines `ffmpeg -i` printed for one file. Same information the Go
// server gets from ffprobe's JSON, just read from the log output.
function parseProbe(lines) {
  const pi = {
    duration: 0, size: 0,
    hasVideo: false, width: 0, height: 0, vcodec: "", pixfmt: "", framerate: "",
    hasAudio: false, acodec: "", sampleRate: 0, channels: 0, channelLayout: "",
  };
  for (const line of lines) {
    let m = line.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) pi.duration = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);

    m = line.match(/Stream #\d+:\d+[^:]*: (Video|Audio): ([A-Za-z0-9_]+)/);
    if (!m) continue;

    if (m[1] === "Video") {
      // Embedded cover art (album art in mp3/m4a) is not a real video track.
      if (line.includes("(attached pic)")) continue;
      if (pi.hasVideo) continue;
      pi.hasVideo = true;
      pi.vcodec = m[2];
      const px = line.match(/Video: [^,]+, ([a-z][a-z0-9_]*)/);
      if (px) pi.pixfmt = px[1];
      const dim = line.match(/, (\d{2,5})x(\d{2,5})/);
      if (dim) { pi.width = +dim[1]; pi.height = +dim[2]; }
      const fps = line.match(/, ([\d.]+) fps/) || line.match(/, ([\d.]+) tbr/);
      if (fps) pi.framerate = fps[1];
    } else {
      if (pi.hasAudio) continue;
      pi.hasAudio = true;
      pi.acodec = m[2];
      const sr = line.match(/(\d+) Hz/);
      if (sr) pi.sampleRate = +sr[1];
      const layout = line.match(/\d+ Hz, ([^,]+)/);
      if (layout) {
        pi.channelLayout = layout[1].trim();
        pi.channels = LAYOUT_CHANNELS[pi.channelLayout] || 0;
      }
    }
  }
  return pi;
}

// Picks the most telling line out of a failed ffmpeg run.
function lastErrorLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/Error|error|Invalid|failed|No such|moov|not found/.test(l)) return l;
  }
  return lines.length ? lines[lines.length - 1] : "no details available";
}

// Runs `ffmpeg -i <name>` and returns the parsed stream information.
async function probeFile(name, displayName, size) {
  const lines = [];
  logTarget = lines;
  try {
    await ff.exec(["-hide_banner", "-i", name]);
  } catch (e) {
    // a cancelled engine rejects - let the caller deal with it
    if (state.cancelled || /terminate/.test(String(e && e.message))) throw e;
  } finally {
    logTarget = null;
  }
  const pi = parseProbe(lines);
  pi.size = size || 0;
  if (!pi.hasVideo && !pi.hasAudio) {
    // ffmpeg prefixes its complaints with the input path - show the real name
    let why = lastErrorLine(lines);
    if (why.startsWith(name + ":")) why = why.slice(name.length + 1).trim();
    throw new Error(`could not read "${displayName}": ${why}`);
  }
  return pi;
}

// ---------------------------------------------------------------- pipeline

const durWeight = (d) => (d <= 0 ? 1 : d);
const sumDur = (ss) => ss.reduce((a, s) => a + s.pi.duration, 0);

function sameVideoParams(vs) {
  const a = vs[0].pi;
  return vs.slice(1).every((s) => {
    const b = s.pi;
    return a.vcodec === b.vcodec && a.pixfmt === b.pixfmt &&
      a.width === b.width && a.height === b.height && a.framerate === b.framerate;
  });
}

function sameAudioParams(as) {
  const a = as[0].pi;
  return as.slice(1).every((s) => {
    const b = s.pi;
    return a.acodec === b.acodec && a.sampleRate === b.sampleRate && a.channels === b.channels;
  });
}

const allHaveAudio = (vs) => vs.every((s) => s.pi.hasAudio);
const anyHasAudio = (vs) => vs.some((s) => s.pi.hasAudio);
const noneHasAudio = (vs) => vs.every((s) => !s.pi.hasAudio);

// Needed for the concat demuxer, which copies every stream.
function uniformAudioLayout(vs) {
  if (noneHasAudio(vs)) return true;
  if (!allHaveAudio(vs)) return false;
  return sameAudioParams(vs);
}

function mergeArgs(o, videoPath, audioPath, out, encodeVideo, videoHasAudio) {
  const mix = o.mode === "mix" && videoHasAudio;
  const args = ["-hide_banner", "-nostdin", "-y", "-i", videoPath, "-i", audioPath];

  if (mix) {
    // When "trim to shortest" is on, the mixed track ends with the shorter
    // audio input so that -shortest also trims the video to that length.
    const duration = o.shortest ? "shortest" : "longest";
    const filter = `[1:a]volume=${o.mixVolume.toFixed(3)}[music];` +
      `[0:a][music]amix=inputs=2:duration=${duration}:dropout_transition=0:normalize=0[aout]`;
    args.push("-filter_complex", filter, "-map", "0:v:0", "-map", "[aout]");
  } else {
    args.push("-map", "0:v:0", "-map", "1:a:0");
  }

  if (encodeVideo) {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p");
  } else {
    args.push("-c:v", "copy");
  }

  if (mix || o.audioCodec !== "copy") {
    args.push("-c:a", "aac", "-b:a", o.audioBitrate);
  } else {
    args.push("-c:a", "copy");
  }

  if (o.shortest) args.push("-shortest");
  if (o.container === "mp4") args.push("-movflags", "+faststart");
  args.push(out);
  return args;
}

// Joins clips with the concat filter (re-encodes video). In mix mode the
// clips' own audio is kept as well; silent clips get a matching stretch of
// silence so every segment has an audio track.
function videoConcatFilterStage(o, vs, out, totalDur) {
  const wantAudio = o.mode === "mix" && anyHasAudio(vs);
  const first = vs[0].pi;
  let w = first.width, h = first.height;
  if (!w || !h) { w = 640; h = 360; }
  const fps = first.framerate && first.framerate !== "0" ? first.framerate : "30";

  const args = ["-hide_banner", "-nostdin", "-y"];
  for (const s of vs) args.push("-i", s.path);

  const audioRef = new Array(vs.length);
  let nextInput = vs.length;
  let silentFilled = false;
  if (wantAudio) {
    vs.forEach((s, i) => {
      if (s.pi.hasAudio) {
        audioRef[i] = `[${i}:a]`;
        return;
      }
      args.push("-f", "lavfi", "-t", (durWeight(s.pi.duration) + 0.5).toFixed(3),
        "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      audioRef[i] = `[${nextInput}:a]`;
      nextInput++;
      silentFilled = true;
    });
    if (silentFilled) {
      state.engineLogs.push("note: some clips have no audio track - silence was inserted so the tracks could be joined");
    }
  }

  const filters = [], seq = [];
  vs.forEach((_, i) => {
    filters.push(`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`);
    seq.push(`[v${i}]`);
    if (wantAudio) {
      filters.push(`${audioRef[i]}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      seq.push(`[a${i}]`);
    }
  });
  // concat expects the streams of each segment grouped together: v0 a0 v1 a1 …
  let labels = "[vout]", audioFlag = 0;
  if (wantAudio) { labels = "[vout][aout]"; audioFlag = 1; }
  const graph = filters.join(";") + ";" + seq.join("") +
    `concat=n=${vs.length}:v=1:a=${audioFlag}${labels}`;

  args.push("-filter_complex", graph, "-map", "[vout]");
  if (wantAudio) args.push("-map", "[aout]");
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p");
  if (wantAudio) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-f", "matroska", out);

  return {
    label: `joining ${vs.length} video clips (re-encoding)`,
    args, target: totalDur, weight: durWeight(totalDur),
  };
}

function audioConcatFilterStage(as, out, totalDur) {
  const args = ["-hide_banner", "-nostdin", "-y"];
  for (const s of as) args.push("-i", s.path);

  const filters = [], seq = [];
  as.forEach((_, i) => {
    filters.push(`[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    seq.push(`[a${i}]`);
  });
  const graph = filters.join(";") + ";" + seq.join("") + `concat=n=${as.length}:v=0:a=1[aout]`;

  args.push("-filter_complex", graph, "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-f", "matroska", out);

  return {
    label: `joining ${as.length} audio files`,
    args, target: totalDur, weight: 0.25 * durWeight(totalDur),
  };
}

// Builds the same up-to-three-stage pipeline as the Go server: join videos ->
// join audio -> merge, with weighted progress and copy->filter fallbacks.
function planJob(o, vs, as, outName) {
  const p = {
    video: vs[0].path,
    audio: as[0].path,
    videoDur: sumDur(vs),
    audioDur: sumDur(as),
    videoHasAudio: vs[0].pi.hasAudio,
    videoEncoded: false,
    stages: [],
    intermediates: [],
    lists: [], // concat list files that must be written before running
  };

  // ---- join multiple videos ------------------------------------------------
  if (vs.length > 1) {
    const out = "joined-video.mkv";
    // Clips' own audio is only needed in mix mode (and only if any clip has
    // some). Otherwise the joined video is video-only, so the concat demuxer
    // can stream-copy as long as the video parameters match.
    const keepAudio = o.mode === "mix" && anyHasAudio(vs);
    const copyable = sameVideoParams(vs) && (!keepAudio || uniformAudioLayout(vs));
    const filterStage = () => videoConcatFilterStage(o, vs, out, p.videoDur);

    if (copyable) {
      const list = writeConcatList("concat-video.txt", vs);
      p.lists.push(list);
      const args = ["-hide_banner", "-nostdin", "-y",
        "-f", "concat", "-safe", "0", "-i", list.name,
        "-c", "copy", "-fflags", "+genpts", "-avoid_negative_ts", "make_zero"];
      if (!keepAudio) args.push("-map", "0:v:0"); // drop clip audio, it is unused
      args.push("-f", "matroska", out);

      p.stages.push({
        label: `joining ${vs.length} video clips`,
        args, target: p.videoDur, weight: 0.1 * durWeight(p.videoDur),
        fallback: filterStage,
      });
      p.videoHasAudio = keepAudio;
    } else {
      p.stages.push(filterStage());
      p.videoEncoded = true; // the filter stage re-encodes, the merge can copy
      p.videoHasAudio = o.mode === "mix" && anyHasAudio(vs);
    }
    p.video = out;
    p.intermediates.push(out);
  }

  // ---- join multiple audio files ------------------------------------------
  if (as.length > 1) {
    const out = "joined-audio.mkv";
    const filterStage = () => audioConcatFilterStage(as, out, p.audioDur);

    if (sameAudioParams(as)) {
      const list = writeConcatList("concat-audio.txt", as);
      p.lists.push(list);
      p.stages.push({
        label: `joining ${as.length} audio files`,
        args: ["-hide_banner", "-nostdin", "-y",
          "-f", "concat", "-safe", "0", "-i", list.name,
          "-c", "copy", "-fflags", "+genpts", "-avoid_negative_ts", "make_zero",
          "-f", "matroska", out],
        target: p.audioDur, weight: 0.1 * durWeight(p.audioDur),
        fallback: filterStage,
      });
    } else {
      p.stages.push(filterStage());
    }
    p.audio = out;
    p.intermediates.push(out);
  }

  // ---- final merge ---------------------------------------------------------
  let target = p.videoDur;
  if (o.shortest && p.audioDur > 0) target = Math.min(p.videoDur, p.audioDur);
  const encodeVideo = o.videoCodec === "x264" && !p.videoEncoded;

  let weight = 0.3 * durWeight(target);
  if (encodeVideo) weight = 1.0 * durWeight(target);

  p.stages.push({
    label: "merging video + audio",
    args: mergeArgs(o, p.video, p.audio, outName, encodeVideo, p.videoHasAudio),
    target, weight,
  });
  return p;
}

function writeConcatList(name, ss) {
  const text = ss.map((s) => `file '${s.path.replace(/'/g, `'\\''`)}'\n`).join("");
  return { name, text };
}

// Copies a dropped file into the ffmpeg memory filesystem.
function fsName(kind, i, original) {
  const ext = extOf(original);
  const known = kind === "audio" ? AUDIO_EXT.includes(ext) : VIDEO_EXT.includes(ext);
  return `in-${kind}-${i}${known ? ext : ".bin"}`;
}

// ---------------------------------------------------------------- job run

let stageProgress = null; // { base, weight, total, target, label }

function hookProgress(timeUs) {
  if (!stageProgress || !stageProgress.target) return;
  let p = (timeUs / 1e6) / stageProgress.target;
  if (p < 0) p = 0;
  if (p > 0.995) p = 0.995;
  setBar(((stageProgress.base + p * stageProgress.weight) / stageProgress.total) * 100, false);
  $("#progress-text").textContent =
    `${stageProgress.label} · ${Math.min(99.5, ((stageProgress.base + p * stageProgress.weight) / stageProgress.total) * 100).toFixed(1)}%`;
}

async function writeFilesToFs(items) {
  for (const it of items) {
    const data = new Uint8Array(await it.file.arrayBuffer());
    await ff.writeFile(it.path, data);
    if (state.cancelled) throw new Error("cancelled");
  }
}

async function runJob() {
  const o = readOptions();
  state.running = true;
  state.cancelled = false;
  state.jobId = randomId();
  state.engineLogs = [];
  document.querySelector("#logbox").hidden = true;
  document.querySelector("#log").textContent = "";

  $("#merge").disabled = true;
  $("#cancel").hidden = false;
  $("#reset").hidden = true;

  const started = Date.now();
  const elapsedTimer = setInterval(() => {
    $("#elapsed").textContent = `elapsed ${humanMs(Date.now() - started)}`;
  }, 500);

  const outName = `merged-${state.jobId}.${o.container}`;
  let inputs = [];

  try {
    // ---- copy the files into the ffmpeg filesystem -----------------------
    setStatus("copying", "running");
    setBar(0, true);
    $("#progress-text").textContent = "copying files into memory…";
    inputs = [
      ...state.files.video.map((file, i) => ({ file, kind: "video", path: fsName("video", i + 1, file.name) })),
      ...state.files.audio.map((file, i) => ({ file, kind: "audio", path: fsName("audio", i + 1, file.name) })),
    ];
    await writeFilesToFs(inputs);
    if (state.cancelled) throw new Error("cancelled");

    // ---- probe every file and sort it by what it really contains ---------
    $("#progress-text").textContent = "examining streams…";
    const sources = [];
    for (const it of inputs) {
      const pi = await probeFile(it.path, it.file.name, it.file.size);
      sources.push({ ...it, pi });
    }
    const { vs, as, moved } = classifySources(sources);
    if (moved) applyKinds(sources.map((s) => ({ file: s.file, kind: s.kind })));
    if (!vs.length) throw new Error("no video found - add at least one file that contains a video stream");
    if (!as.length) throw new Error("no audio found - add at least one audio file (or a video that has an audio track)");

    renderMediaInfo(vs, as);

    // ---- build and run the pipeline --------------------------------------
    const plan = planJob(o, vs, as, outName);
    for (const l of plan.lists) {
      await ff.writeFile(l.name, new TextEncoder().encode(l.text));
    }

    const total = plan.stages.reduce((a, s) => a + s.weight, 0) || 1;
    let completed = 0;

    for (let i = 0; i < plan.stages.length; i++) {
      let st = plan.stages[i];
      setStage(st, completed, total);
      let from = state.engineLogs.length;
      let code = await ff.exec(st.args);
      if (code !== 0 && st.fallback && !state.cancelled) {
        state.engineLogs.push("note: " + st.label + " needed re-encoding after all");
        const fb = st.fallback();
        total += fb.weight - st.weight;
        st = fb;
        setStage(st, completed, total);
        from = state.engineLogs.length;
        code = await ff.exec(st.args);
      }
      if (state.cancelled) throw new Error("cancelled");
      if (code !== 0) throw new Error(`ffmpeg failed: ${lastErrorLine(state.engineLogs.slice(from))}`);
      completed += st.weight;
      setBar((completed / total) * 100, false);
    }
    stageProgress = null;

    // ---- hand the result to the browser ----------------------------------
    const data = await ff.readFile(outName);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    const blob = new Blob([bytes], { type: o.container === "mp4" ? "video/mp4" : "video/x-matroska" });

    if (state.url) URL.revokeObjectURL(state.url);
    state.url = URL.createObjectURL(blob);

    setBar(100, false);
    $("#dl").hidden = false;
    $("#dl-link").href = state.url;
    $("#dl-link").setAttribute("download", outName);
    $("#dl-hint").textContent = `${outName} · ${humanBytes(blob.size)}`;
    $("#progress-text").textContent = `finished · output is about ${humanTimeFromInfo(vs)} long`;
    setStatus("done", "done");
    $("#reset").hidden = false;
    $("#speed").textContent = "";
  } catch (err) {
    if (state.cancelled) {
      setStatus("cancelled", "error");
      $("#progress-text").textContent = "cancelled";
      $("#reset").hidden = false;
    } else {
      showError(err && err.message ? err.message : String(err));
      $("#reset").hidden = false;
    }
  } finally {
    clearInterval(elapsedTimer);
    stageProgress = null;
    state.running = false;
    $("#cancel").hidden = true;
    $("#log").textContent = state.engineLogs.join("\n");
    if (state.engineLogs.length) $("#logbox").hidden = false;
    await cleanupFs(inputs, outName);
    updateMergeButton();
  }
}

function setStatus(text, cls) {
  $("#status-badge").textContent = text;
  $("#status-badge").className = `badge ${cls}`;
}

function setStage(st, completed, total) {
  stageProgress = { base: completed, weight: st.weight, total, target: st.target, label: st.label };
  $("#progress-text").textContent = `${st.label}…`;
  $("#speed").textContent = "";
  setBar((completed / total) * 100, false);
}

// Sorts the probed files into video/audio sources, exactly like the Go server:
// content decides, ambiguous files keep the side they were dropped on.
function classifySources(sources) {
  const vs = [], as = [];
  let moved = false;
  for (const s of sources) {
    const declared = s.kind;
    if (s.pi.hasVideo && s.pi.hasAudio) {
      s.kind = declared;
    } else if (s.pi.hasVideo) {
      s.kind = "video";
      if (declared === "audio") {
        state.engineLogs.push(`note: "${s.file.name}" was dropped as audio but has no audio track - used as a video instead`);
        moved = true;
      }
    } else {
      s.kind = "audio";
      if (declared === "video") {
        state.engineLogs.push(`note: "${s.file.name}" was dropped as video but has no video stream - used as audio instead`);
        moved = true;
      }
    }
  }
  for (const s of sources) (s.kind === "video" ? vs : as).push(s);
  return { vs, as, moved };
}

// Moves rows in the UI to match the content-based classification.
function applyKinds(entries) {
  const out = { video: [], audio: [] };
  for (const e of entries) {
    const kind = e.kind === "video" || e.kind === "audio" ? e.kind : (state.files.video.includes(e.file) ? "video" : "audio");
    out[kind].push(e.file);
  }
  state.files = out;
  renderZone("video");
  renderZone("audio");
}

async function cleanupFs(inputs, outName) {
  const paths = new Set([...inputs.map((i) => i.path), "joined-video.mkv", "joined-audio.mkv", "concat-video.txt", "concat-audio.txt", outName]);
  for (const p of paths) {
    try { await ff.deleteFile(p); } catch (e) { /* not there */ }
  }
}

function humanTimeFromInfo(vs) {
  const dur = vs.reduce((a, s) => a + (s.pi.duration || 0), 0);
  return humanDuration(dur);
}

function renderMediaInfo(vs, as) {
  const v = {
    count: vs.length,
    duration: vs.reduce((a, s) => a + s.pi.duration, 0),
    size: vs.reduce((a, s) => a + s.pi.size, 0),
    codec: vs[0].pi.vcodec,
    width: vs[0].pi.width,
    height: vs[0].pi.height,
  };
  const a = {
    count: as.length,
    duration: as.reduce((a, s) => a + s.pi.duration, 0),
    size: as.reduce((a, s) => a + s.pi.size, 0),
    audioCodec: as[0].pi.acodec,
  };
  const bits = [];
  if (v.count > 1) bits.push(`${v.count} clips`);
  if (v.width && v.height) bits.push(`${v.width}×${v.height}`);
  if (v.codec) bits.push(v.codec);
  if (v.duration) bits.push(humanDuration(v.duration));
  if (v.size) bits.push(humanBytes(v.size));
  $("#mi-video").innerHTML = `🎥 <b>video</b><br>${bits.join(" · ") || "unknown"}`;

  const abits = [];
  if (a.count > 1) abits.push(`${a.count} files`);
  if (a.audioCodec) abits.push(a.audioCodec);
  if (a.duration) abits.push(humanDuration(a.duration));
  if (a.size) abits.push(humanBytes(a.size));
  $("#mi-audio").innerHTML = `🎵 <b>audio</b><br>${abits.join(" · ") || "unknown"}`;
  $("#media-info").hidden = false;
}

// ---------------------------------------------------------------- actions

$("#merge").addEventListener("click", () => {
  if (state.running || !state.files.video.length || !state.files.audio.length) return;
  showResult();
  runJob();
});

$("#cancel").addEventListener("click", async () => {
  if (!state.running) return;
  state.cancelled = true;
  try { ff.terminate(); } catch (e) { /* ignore */ }
  state.engineReady = false;
  updateMergeButton();
  const el = $("#health");
  el.textContent = "loading ffmpeg core…";
  el.className = "pill";
  // bring a fresh engine up for the next run
  loadEngine()
    .then(() => {
      el.textContent = "ffmpeg ready · on-device";
      el.className = "pill ok";
    })
    .catch((err) => {
      el.textContent = "ffmpeg failed to load";
      el.className = "pill bad";
      el.title = String(err && err.message ? err.message : err);
    });
});

$("#reset").addEventListener("click", async () => {
  if (state.url) {
    URL.revokeObjectURL(state.url);
    state.url = null;
  }
  state.jobId = null;
  state.files.video = [];
  state.files.audio = [];
  renderZone("video");
  renderZone("audio");
  $("#result").hidden = true;
  $("#reset").hidden = true;
  $("#cancel").hidden = true;
  $("#speed").textContent = "";
  $("#elapsed").textContent = "";
  setBar(0, false);
  updateMergeButton();
});

function showResult() {
  const box = $("#result");
  box.hidden = false;
  $("#errbox").hidden = true;
  $("#errbox").textContent = "";
  $("#dl").hidden = true;
  $("#media-info").hidden = true;
  $("#logbox").hidden = true;
  $("#log").textContent = "";
  $("#bar-fill").style.background = "";
  setStatus("running", "running");
  setBar(0, true);
  $("#progress-text").textContent = "starting…";
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

window.addEventListener("beforeunload", (e) => {
  if (!state.running) return;
  e.preventDefault();
  e.returnValue = "";
});
