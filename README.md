# voice — local Whisper dictation for Pop!_OS / COSMIC

Push-to-talk → faster-whisper (`distil-large-v3` on CUDA) → ydotool types into the
focused window. Audio + transcript are always saved so a bad transcription can
be re-run later. While recording, a tiny phosphor-green oscilloscope strip
appears at the bottom of the screen as a Wayland layer-shell overlay — it
**does not steal focus** and **does not reserve screen space**.

## Layout

```
~/voice/
├── bin/
│   ├── voice-daemon        # long-lived: socket server, recorder, transcriber
│   ├── voice-ptt           # 1-line client; bind your hotkey to this
│   ├── voice-retry         # re-transcribe any saved wav
│   ├── voice-indicator     # recording-pill overlay (spawned by the daemon)
│   └── voice-gui           # local web app: history, playback, themes
├── lib/webui/              # static assets for voice-gui
├── themes/                 # *.json palettes shared by the GUI + the pill
├── config.json             # active theme selection
├── recordings/             # YYYY-MM-DD_HH-MM-SS.wav
├── transcripts/            # matching .txt files
├── logs/                   # daemon.log, indicator.log, gui.log
├── venv/                   # Python deps (faster-whisper, sounddevice…)
├── voice-daemon.service    # systemd --user unit (template)
├── voice-gui.service       # systemd --user unit (template)
├── ydotoold.service        # systemd --user unit (template)
└── install.sh
```

## Install

```bash
~/voice/install.sh
```

The script handles apt deps (incl. GTK3 + layer-shell for the indicator), the
`input` group + udev rule for `/dev/uinput`, the venv, both systemd `--user`
services, and a one-time model download. **If it adds you to the `input` group
you must log out and back in once.**

## Bind a hotkey in COSMIC

Settings → Input → Keyboard → Custom Shortcuts → +

- **Command:** `/home/shoyo/voice/bin/voice-ptt`
- **Key:** suggested `Super+grave` (the backtick — easy to find by feel)

Press once to start recording, press again to stop. The text types into
whatever window is focused.

## Hybrid GPU / on-demand CUDA

The dGPU only does work when you actually dictate.

- The model is **lazy-loaded**: nothing is on the GPU when the daemon starts.
- Pressing the hotkey to start recording **kicks off model load in the background**
  in parallel with you speaking, so by the time you stop talking it's ready.
- After `VOICE_IDLE_UNLOAD` seconds (default **300**) of inactivity the model is
  unloaded, the CUDA context is released, and Pop!_OS hybrid runtime-pm puts
  the dGPU back to sleep. Confirm with `nvidia-smi` — power should fall back to
  ~1–2W when nothing is using it.
- If CUDA load fails for any reason, the daemon falls back to CPU/int8 so
  dictation still works.

Tunables (env vars in `~/.config/systemd/user/voice-daemon.service`):

| var                    | default            | notes                                    |
|------------------------|--------------------|------------------------------------------|
| `VOICE_MODEL`          | `distil-large-v3`  | `large-v3` for max accuracy, `medium.en` for less VRAM |
| `VOICE_DEVICE`         | `cuda`             | falls back to `cpu` automatically on load failure |
| `VOICE_COMPUTE`        | `float16`          | `int8_float16` saves VRAM                |
| `VOICE_IDLE_UNLOAD`    | `300`              | seconds; `0` = never unload (keep GPU warm) |
| `VOICE_MIN_RECORD_SEC` | `0.3`              | shorter clips are saved but not transcribed |
| `VOICE_MAX_RECORD_SEC` | `900`              | hard cap (15 min) so a stuck session can't OOM |

After editing: `systemctl --user daemon-reload && systemctl --user restart voice-daemon`.

## On-screen indicator (the niche bit)

While recording, a 32-px tall strip appears at the bottom of your primary
display:

```
[ ●  REC  00:03 ]   /\___/^\____~~~~|/|\|~~__/\____
```

- Pulsing red dot whose bloom modulates with mic input
- Phosphor-green monospace timer with subtle chromatic ghosting
- Scrolling oscilloscope showing the trailing ~3 seconds of mic envelope
- Faint scanline overlay for the CRT vibe

It's a Wayland **layer-shell overlay** with `keyboard_mode=NONE` and
`exclusive_zone=0`, so it sits above all windows without grabbing focus or
shrinking the workspace. The compositor (`cosmic-comp`) implements
`wlr-layer-shell-unstable-v1`, which is what makes this possible.

If you want to tweak the look: it's all Cairo in
[`bin/voice-indicator`](bin/voice-indicator).

## History & themes GUI

`voice-gui` serves a local web app on **http://127.0.0.1:8765** (also in the app
launcher as "Voice History"). It is a separate process from the daemon on
purpose — a GUI crash can never take down dictation. Stdlib-only Python, no
venv, talks to the daemon over its existing unix socket.

What it does:

- **Timeline** of every recording with its transcript, grouped by day,
  searchable (press `/`), with click-to-seek waveforms decoded in the browser.
- **Playback** straight from `recordings/` (HTTP Range, so seeking works).
- **Re-transcribe** any take via the daemon (model stays warm) — useful when a
  transcription came out wrong; the wav was always kept.
- **Delete** a take (wav + txt) with confirm.
- **Record button** — same toggle as the hotkey. Note: the transcript types
  into the focused window, exactly like the hotkey.
- **Themes** — palettes live in `themes/*.json`; the active one is set in
  `config.json` and drives **both** the web UI and the recording pill
  (`voice-indicator` reads it at spawn, so the pill follows from the next
  recording). Built-ins: Karasuno, Phosphor, Nekoma, Seijoh. The editor in the
  GUI clones any theme, live-previews edits, and saves custom ones.

Tunables: `VOICE_GUI_PORT` (default 8765), `VOICE_GUI_HOST` (default
127.0.0.1), `VOICE_ROOT` — set in `voice-gui.service`. The server binds
localhost only; anything that can reach the port can read transcripts, so
don't bind it wider on a shared machine.

If a transcription is running (re-transcribe or a long take), the daemon
serves connections serially — the GUI shows "transcribing…" and recording
toggles are rejected with "busy" until it finishes. Same behaviour as
`voice-retry` always had.

## Day-to-day

```bash
systemctl --user status voice-daemon ydotoold voice-gui
journalctl --user -u voice-daemon -f          # live logs

voice-ptt                                     # toggle (same as the hotkey)
voice-ptt status                              # IDLE | RECORDING + model state
voice-ptt unload                              # force model unload now (free VRAM)

voice-retry --type ~/voice/recordings/<file>.wav        # re-do via daemon
voice-retry --standalone --model large-v3 <file>.wav    # one-off with bigger model
```

## Robustness features

- **Singleton lock** — only one daemon at a time (flock on a pidfile)
- **Pre-flight checks** — verifies input device + ydotoold socket on startup
- **Audio device failure** — clean up the wav, notify, no half-open streams
- **Hard duration cap** — `VOICE_MAX_RECORD_SEC` so a stuck session can't OOM
- **Toggle re-entrancy guard** — second toggle while transcribing is rejected, not queued
- **Save before transcribe** — wav is always flushed before transcription is attempted
- **Clipboard fallback** — if `ydotool` fails, transcript goes to `wl-copy`
- **Signal handling** — SIGTERM/SIGINT close any in-flight recording and clean sockets
- **Transcribe error never loses audio** — wav stays in `recordings/`; rerun with `voice-retry`

## Troubleshooting

- **No text appears** — check `ydotoold` is running: `systemctl --user status ydotoold`.
  Verify `/dev/uinput` is `crw-rw---- root input`. Confirm `groups` lists `input`.
- **Daemon won't start, CUDA errors** — usually `LD_LIBRARY_PATH` in the unit doesn't
  match the venv's python version. Re-run `install.sh`; it patches the path.
  Worst case the daemon will auto-fall-back to CPU and keep working.
- **Empty transcript on speech** — VAD may be trimming too aggressively. Lower
  `min_silence_duration_ms` in `voice-daemon` (search the file).
- **Wrong mic** — set `SD_DEFAULT_INPUT` env var to a device index (find with
  `python3 -c "import sounddevice; print(sounddevice.query_devices())"`).
- **Indicator doesn't appear** — check `~/voice/logs/indicator.log`. The
  `gir1.2-gtklayershell-0.1` package must be present; the indicator is launched
  with `/usr/bin/python3` (not the venv) so apt-installed bindings are visible.
- **dGPU never sleeps** — set `VOICE_IDLE_UNLOAD=120` for faster unload, or
  `voice-ptt unload` to drop the model on demand. Verify with
  `nvidia-smi --query-gpu=power.draw --format=csv,noheader`.

## What this is not

- A wake-word system (you press a key)
- A streaming transcriber (it transcribes once you stop talking)
- Cloud (everything runs on your 4060)
