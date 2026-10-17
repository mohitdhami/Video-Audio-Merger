"use strict";

const $ = (sel) => document.querySelector(sel);

const state = {
  files: { video: [], audio: [] },
  jobId: null,
  poll: null,
  done: false,
  dragFrom: null, // { kind, index } while reordering rows
  pendingDetects: 0, // files whose contents are still being sniffed
  sent: null, // { list: [{ file, kind }] } snapshot of the last upload
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

// Looks at the first bytes of a file and guesses the *kind* of its content,
// the same way the server does with ffprobe (only cheaper). Returns "video",
// "audio" or "" when the container alone does not tell.
async function sniffKind(file) {
  let bytes;
  try {
    bytes = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
  } catch (e) {
    return "";
  }
  if (bytes.length < 12) return "";

  // Containers that can only be audio.
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

  // mp4/mov family: use the stream handler ("vide"/"soun") when the movie
  // header sits at the front of the file.
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

  // matroska/webm: look for TrackType entries (1 = video, 2 = audio).
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

  // Everything else that is clearly a moving-picture container.
  if (bytes[0] === 0x47) return "video"; // MPEG-TS
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1) return "video"; // MPEG-PS/ES
  if (matchASCII(bytes, 0, "FLV")) return "video";
  if (bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xb2 && bytes[3] === 0x75) return "video"; // ASF
  return "";
}

// Decides which list a dropped file belongs in: mostly by what is inside it,
// with the extension as a backup (and a hint for containers that cannot be
// told apart from a prefix alone, like a non-faststart .m4a).
async function detectKind(file) {
  if (STRONG_AUDIO_EXT.includes(extOf(file.name))) return "audio";
  const sniffed = await sniffKind(file);
  if (sniffed) return sniffed;
  return classify(file);
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

// ---------------------------------------------------------------- health

fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    const el = $("#health");
    if (h.ok) {
      el.textContent = "ffmpeg ready";
      el.classList.add("ok");
      el.title = h.ffmpeg || "";
    } else {
      el.textContent = "ffmpeg missing";
      el.classList.add("bad");
      el.title = "Install ffmpeg and make sure it is on PATH.";
    }
  })
  .catch(() => {
    const el = $("#health");
    el.textContent = "server unreachable";
    el.classList.add("bad");
  });

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
    // Some browsers need data set for the drag to start.
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
    // OS file drops onto a row bubble up to the zone, which adds them.
    if (!from) return;
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
  btn.disabled = nv === 0 || na === 0 || state.jobId !== null || state.pendingDetects > 0;
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
      // A row was dropped on the zone background (possibly from the other list).
      moveFile(state.dragFrom.kind, state.dragFrom.index, kind, state.files[kind].length);
      return;
    }
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) addFiles(kind, Array.from(files));
  });
}

setupZone("video", "#zone-video", "#file-video", "#add-video", "#clear-video");
setupZone("audio", "#zone-audio", "#file-audio", "#add-audio", "#clear-audio");

// Safety net: if a drag ends anywhere, forget it.
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

// ---------------------------------------------------------------- merge

$("#merge").addEventListener("click", () => {
  const videos = state.files.video;
  const audios = state.files.audio;
  if (!videos.length || !audios.length) return;

  const fd = new FormData();
  fd.append("mode", $("#mode").value);
  fd.append("videoCodec", $("#videoCodec").value);
  fd.append("audioCodec", $("#audioCodec").value);
  fd.append("audioBitrate", $("#audioBitrate").value);
  fd.append("container", $("#container").value);
  fd.append("shortest", $("#shortest").checked ? "true" : "false");
  // The mix volume is fixed at the server default (50%) - no UI for it.
  // order matters: clips are joined in the order they appear in the lists
  videos.forEach((f) => fd.append("video", f, f.name));
  audios.forEach((f) => fd.append("audio", f, f.name));
  // remember what was sent under which side, so the answer from the server
  // (which re-checks every file by content) can be mapped back onto the lists
  state.sent = {
    list: [
      ...videos.map((f) => ({ file: f, kind: "video" })),
      ...audios.map((f) => ({ file: f, kind: "audio" })),
    ],
  };

  showResult();
  $("#merge").disabled = true;
  $("#reset").hidden = true;
  $("#status-badge").textContent = "uploading";
  $("#status-badge").className = "badge running";
  $("#progress-text").textContent = "uploading files…";
  setBar(0, true);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/jobs");

  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = (e.loaded / e.total) * 100;
    setBar(pct, false);
    $("#progress-text").textContent =
      `uploading ${humanBytes(e.loaded)} / ${humanBytes(e.total)}`;
  };

  xhr.upload.onload = () => {
    setBar(0, true);
    $("#progress-text").textContent = "upload complete, starting ffmpeg…";
  };

  xhr.onload = () => {
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
    // The server probed every file: show them under the side they ended up on.
    if (data.files) applyServerKinds(data.files);
    if (xhr.status !== 202) {
      showError(data.error || `server responded with HTTP ${xhr.status}`);
      updateMergeButton(); // the lists are still there - let the user retry
      return;
    }
    state.jobId = data.id;
    renderJob(data);
    state.poll = setInterval(pollJob, 600);
  };

  xhr.onerror = () => {
    showError("network error while uploading — is the server still running?");
    updateMergeButton();
  };
  xhr.send(fd);
});

// Re-sorts the file lists to match the server's content check. Files that were
// added or removed while the upload was running are left alone.
function applyServerKinds(serverFiles) {
  const sent = state.sent && state.sent.list;
  if (!sent || serverFiles.length !== sent.length) return;

  const out = { video: [], audio: [] };
  const claimed = new Set();
  let moved = 0;
  serverFiles.forEach((sf, i) => {
    const entry = sent[i];
    const file = entry.file;
    const current = state.files.video.includes(file) ? "video"
      : state.files.audio.includes(file) ? "audio" : null;
    if (!current) return; // removed while uploading
    claimed.add(file);
    const kind = sf.kind === "video" || sf.kind === "audio" ? sf.kind : entry.kind;
    if (kind !== entry.kind) moved++;
    out[kind].push(file);
  });
  ["video", "audio"].forEach((kind) => {
    for (const f of state.files[kind]) {
      if (!claimed.has(f)) out[kind].push(f); // added during the upload
    }
  });

  state.files = out;
  renderZone("video");
  renderZone("audio");
  if (moved > 0) {
    showNote(`${moved} file${moved === 1 ? "" : "s"} moved to the correct list after checking the contents.`);
  }
}

function pollJob() {
  if (!state.jobId || state.done) return;
  fetch(`/api/jobs/${state.jobId}`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(renderJob)
    .catch((err) => {
      stopPolling();
      showError(`lost contact with the server: ${err.message}`);
    });
}

function stopPolling() {
  if (state.poll) { clearInterval(state.poll); state.poll = null; }
}

function renderJob(j) {
  $("#status-badge").textContent = j.status;
  $("#status-badge").className = `badge ${j.status}`;
  $("#elapsed").textContent = j.elapsedMs ? `elapsed ${humanMs(j.elapsedMs)}` : "";

  if (j.status === "queued" || j.status === "running") {
    const stage = j.stage ? `${j.stage} · ` : "";
    if (j.progress > 0) {
      setBar(j.progress, false);
      let text = `${stage}merging… ${j.progress.toFixed(1)}%`;
      if (j.elapsedMs > 1500 && j.progress > 2) {
        const eta = (j.elapsedMs * (100 / j.progress - 1));
        text += ` · about ${humanMs(eta)} left`;
      }
      $("#progress-text").textContent = text;
    } else {
      setBar(0, true);
      $("#progress-text").textContent = j.status === "queued"
        ? "waiting for a worker…"
        : `${stage}examining streams with ffprobe…`;
    }
    $("#speed").textContent = j.speed ? `ffmpeg speed ${j.speed}` : "";
  }

  renderMediaInfo(j);

  if (j.status === "done") {
    stopPolling();
    state.done = true;
    setBar(100, false);
    $("#speed").textContent = "";
    const secs = j.video && j.video.duration ? humanDuration(j.video.duration) : "";
    $("#progress-text").textContent = secs ? `finished · output is about ${secs} long` : "finished";
    $("#dl").hidden = false;
    $("#dl-link").href = j.downloadURL;
    $("#dl-link").setAttribute("download", j.downloadName || "merged.mp4");
    $("#dl-hint").textContent = `${j.downloadName} · ${humanBytes(j.outputSize)}`;
    $("#reset").hidden = false;
    $("#merge").disabled = true;
  }

  if (j.status === "error") {
    stopPolling();
    state.done = true;
    setBar(100, false);
    $("#bar-fill").style.background = "linear-gradient(90deg, #f85149, #b3281f)";
    showError(j.error || "ffmpeg failed");
    $("#reset").hidden = false;
  }

  if (j.log) {
    $("#log").textContent = j.log;
    $("#logbox").hidden = false;
  }
}

function renderMediaInfo(j) {
  const v = j.video || {};
  const a = j.audio || {};
  if (!v.size && !a.size) return;

  const bits = [];
  if (v.count > 1) bits.push(`${v.count} clips`);
  if (v.width && v.height) bits.push(`${v.width}×${v.height}`);
  if (v.codec) bits.push(v.audioCodec ? `${v.codec} + ${v.audioCodec}` : v.codec);
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

function showError(msg) {
  $("#errbox").hidden = false;
  $("#errbox").textContent = msg;
  $("#status-badge").textContent = "error";
  $("#status-badge").className = "badge error";
  $("#progress-text").textContent = "failed";
}

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
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------------------------------------------------------------- reset

$("#reset").addEventListener("click", () => {
  if (state.jobId) {
    // Best effort: let the server free the temp files right away.
    fetch(`/api/jobs/${state.jobId}`, { method: "DELETE" }).catch(() => {});
  }
  stopPolling();
  state.jobId = null;
  state.done = false;
  state.sent = null;
  state.files.video = [];
  state.files.audio = [];
  renderZone("video");
  renderZone("audio");
  $("#result").hidden = true;
  $("#reset").hidden = true;
  $("#merge").disabled = true;
  $("#speed").textContent = "";
  setBar(0, false);
});

window.addEventListener("beforeunload", stopPolling);
