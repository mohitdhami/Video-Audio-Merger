# videojoin — browser-only (WebAssembly) version

The same app as the Go server, with no server at all: ffmpeg runs **inside the
browser tab** through [ffmpeg.wasm](https://ffmpegwasm.netlify.app/). Files
never leave the machine — they are not even read by anything outside the page.

```
┌───────────────────────────── browser tab ─────────────────────────────┐
│  drop files → sniff/probe content → join videos → join audio → merge  │
│                        (ffmpeg.wasm, in memory)                       │
│  result → Blob → ⬇ download                                          │
└───────────────────────────────────────────────────────────────────────┘
```

## Run it

The page needs to be served over `http://` (workers and `.wasm` files cannot be
loaded from `file://`). Everything else is static, so any way of serving the
folder works:

```sh
./serve.sh              # python3 -m http.server 8080 (starts here)
# or
python3 -m http.server 8080
# or
npx serve .
```

Then open <http://localhost:8080/>. The header shows *ffmpeg ready · on-device*
once the core (about 32 MB, vendored in `core/`) has been loaded. After that the
app works fully offline.

## What is the same as the server version

- Multiple videos and audio files per side, joined in list order; drag rows to
  reorder or move them between the lists.
- Content-based classification: dropped files are placed by looking at their
  bytes (container/stream headers), a mixed drop is split into both lists, and
  `ffmpeg -i` verifies every file before the merge:
  - `stream` without an extension works, a video named `stream.mp3` is a video,
    an audio-only `.mp4` ends up on the audio side, cover art is not video.
  - Unreadable files fail with a clear message; the lists stay usable.
- The same three-stage pipeline with weighted progress and the same fallbacks:
  concat demuxer stream-copy when parameters match, concat filter re-encode
  when they do not, silent clips filled with matching silence in *mix* mode.
  Added track at 50% volume in mix mode (`normalize=0`).
- Options: replace/mix, copy/×264, AAC bitrate, MP4/MKV, trim to shortest.

## Differences from the server version

| topic | server version | this version |
| --- | --- | --- |
| probing | `ffprobe -print_format json` | parsed `ffmpeg -i` output (no ffprobe in the core) |
| storage | temp files on disk, TTL cleanup | RAM only (ffmpeg's in-memory filesystem) |
| size limits | gigabytes (disk) | bounded by WASM memory — keep the total under ~1 GB |
| speed | native ffmpeg | single-thread WebAssembly core, slower for re-encodes (copy paths stay fast) |
| cancel | cancels the job on the server | terminates the engine and loads a fresh one |
| sharing | everyone who can reach the port | files never leave the tab |

## Files

```
index.html   the UI (same layout as the server version)
app.js       lists, sniffing, ffmpeg.wasm pipeline, progress, download
style.css    dark theme
serve.sh     convenience static server (python3)
vendor/      @ffmpeg/ffmpeg 0.12.15 UMD build (ffmpeg.js + worker chunk)
core/        @ffmpeg/core 0.12.10 single-thread build (ffmpeg-core.js/.wasm)
```

The vendored core is the single-thread build, so it works on any static host
without COOP/COEP headers. If you serve the folder with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (so `crossOriginIsolated` is true)
you can drop in `@ffmpeg/core-mt` instead for a big speed-up on re-encodes.
