#!/usr/bin/env bash
# Voice dictation install script.
# Idempotent: safe to re-run. Prompts before destructive steps.
#
# What it does:
#   1. apt installs system deps (ydotool, libportaudio2, python3-venv, wl-clipboard, libnotify-bin)
#   2. adds you to the `input` group + a udev rule so a user-mode ydotoold can access /dev/uinput
#   3. creates a Python venv at ~/voice/venv with faster-whisper + cuDNN/cuBLAS pip wheels
#   4. installs ydotoold and voice-daemon as systemd --user services
#   5. pre-downloads the whisper model so the first dictation isn't slow
#
# Re-login is required after step 2 (group membership). The script tells you when.

set -euo pipefail

VOICE_ROOT="${VOICE_ROOT:-$HOME/voice}"
MODEL="${VOICE_MODEL:-distil-large-v3}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m!! \033[0m %s\n' "$*" >&2; }

confirm() {
    read -r -p "$1 [y/N] " ans
    [[ "${ans,,}" == "y" || "${ans,,}" == "yes" ]]
}

# ---------------------------------------------------------------- 1. apt deps
say "Step 1: apt deps"
PKGS=(
    ydotool libportaudio2 python3-venv python3-pip wl-clipboard libnotify-bin
    # GTK3 + layer-shell for the on-screen oscilloscope indicator (no GTK4 layer-shell in noble).
    python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-gtklayershell-0.1
    libgtk-layer-shell0
)
MISSING=()
for p in "${PKGS[@]}"; do
    dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
done
if (( ${#MISSING[@]} )); then
    say "missing: ${MISSING[*]} — installing with sudo"
    sudo apt-get update
    sudo apt-get install -y "${MISSING[@]}"
else
    say "all apt deps present"
fi

# ---------------------------------------------------------------- 2. uinput group + udev
say "Step 2: /dev/uinput access (input group + udev rule)"

UDEV_RULE=/etc/udev/rules.d/60-voice-uinput.rules
EXPECTED='KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"'
if [[ ! -f "$UDEV_RULE" ]] || ! grep -qF "$EXPECTED" "$UDEV_RULE"; then
    say "writing $UDEV_RULE"
    echo "$EXPECTED" | sudo tee "$UDEV_RULE" >/dev/null
    sudo udevadm control --reload-rules
    sudo udevadm trigger /dev/uinput || true
else
    say "udev rule already in place"
fi

if id -nG "$USER" | tr ' ' '\n' | grep -qx input; then
    say "user already in 'input' group"
    GROUP_ADDED=0
else
    say "adding $USER to 'input' group"
    sudo usermod -aG input "$USER"
    GROUP_ADDED=1
fi

# Make sure no system-wide ydotoold is fighting our user one.
if systemctl is-enabled ydotoold.service >/dev/null 2>&1; then
    if confirm "system-wide ydotoold.service is enabled — disable it (recommended)?"; then
        sudo systemctl disable --now ydotoold.service || true
    fi
fi

# ---------------------------------------------------------------- 3. venv + pip
say "Step 3: Python venv + faster-whisper"

VENV="$VOICE_ROOT/venv"
if [[ ! -d "$VENV" ]]; then
    python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --upgrade pip wheel
pip install \
    faster-whisper \
    sounddevice \
    soundfile \
    numpy \
    nvidia-cublas-cu12 \
    nvidia-cudnn-cu12

# Detect actual python version inside the venv so the systemd unit's LD_LIBRARY_PATH is right.
PYVER=$("$VENV/bin/python" -c 'import sys; print(f"python{sys.version_info[0]}.{sys.version_info[1]}")')
say "venv python: $PYVER"

# ---------------------------------------------------------------- 4. systemd --user units
say "Step 4: systemd --user units"

USER_UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$USER_UNIT_DIR"

# Copy ydotoold unit verbatim (no path substitutions needed).
install -m 0644 "$VOICE_ROOT/ydotoold.service" "$USER_UNIT_DIR/ydotoold.service"

# Patch voice-daemon.service in case the venv python version differs from the template.
sed "s|python3\.12|$PYVER|g" "$VOICE_ROOT/voice-daemon.service" \
    > "$USER_UNIT_DIR/voice-daemon.service"
chmod 0644 "$USER_UNIT_DIR/voice-daemon.service"

# History & themes web GUI (stdlib only — runs on system python3).
install -m 0644 "$VOICE_ROOT/voice-gui.service" "$USER_UNIT_DIR/voice-gui.service"

# App-launcher entry that opens the GUI in the default browser.
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$APPS_DIR"
cat > "$APPS_DIR/voice-history.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Voice History
Comment=Browse dictation recordings, transcripts and themes
Exec=xdg-open http://127.0.0.1:8765
Icon=audio-input-microphone
Terminal=false
Categories=Utility;Audio;
Keywords=voice;dictation;whisper;transcript;
DESKTOP

systemctl --user daemon-reload
systemctl --user enable --now ydotoold.service
systemctl --user enable --now voice-gui.service
# Don't start voice-daemon yet if the user isn't in the input group on this login session.
if (( GROUP_ADDED == 1 )); then
    warn "you were just added to the 'input' group; re-login (or 'newgrp input' in a fresh shell) before starting voice-daemon."
    warn "skipping 'systemctl --user start voice-daemon' for now."
else
    systemctl --user enable --now voice-daemon.service
fi

# ---------------------------------------------------------------- 5. model warmup
say "Step 5: pre-downloading model '$MODEL' (first run only; ~1.5GB)"
"$VENV/bin/python" - <<PY
from faster_whisper import WhisperModel
print("downloading…", flush=True)
WhisperModel("${MODEL}", device="cpu", compute_type="int8")  # cpu+int8 just downloads weights cheaply
print("done")
PY

# ---------------------------------------------------------------- final
cat <<EOF

\033[1;32mInstall complete.\033[0m

Next steps:
  1. ${GROUP_ADDED:+Re-login (or reboot) so 'input' group membership takes effect, then:
       systemctl --user start voice-daemon
  }Verify: systemctl --user status voice-daemon ydotoold
  2. Bind a key in COSMIC settings:
       Settings → Input → Keyboard → Custom Shortcuts → +
       Command: $VOICE_ROOT/bin/voice-ptt
       Suggested key: Super+grave  (the \` key, easy to find by feel)
  3. Press the key to start dictation, press it again to stop. The text types
     into your focused window. The wav stays in $VOICE_ROOT/recordings/.

Logs:    journalctl --user -u voice-daemon -f
Retry:   $VOICE_ROOT/bin/voice-retry --type <wavfile>
GUI:     http://127.0.0.1:8765  (history, playback, re-transcribe, themes)
EOF
