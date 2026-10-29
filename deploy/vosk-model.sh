#!/usr/bin/env bash
# Download the small Chinese Vosk model into a host directory. Idempotent.
# The zip is about 42 MB. --mirror cn points HEARTH_VOSK_MODEL_URL at hf-mirror.

hearth_fetch_vosk_model() {
  local dest="${1:-/var/lib/hearth/vosk}"
  local url="${2:-https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip}"
  local name="vosk-model-small-cn-0.22"
  if [[ -d "$dest/$name/am" ]]; then
    echo "hearth-vosk: model already present at $dest/$name"
    return 0
  fi
  mkdir -p "$dest"
  local tmp
  tmp="$(mktemp)"
  echo "hearth-vosk: downloading $url"
  curl -fL --retry 5 --retry-delay 2 -o "$tmp" "$url"
  if command -v unzip >/dev/null 2>&1; then
    unzip -qo "$tmp" -d "$dest"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -e "$tmp" "$dest"
  else
    echo "hearth-vosk: need unzip or python3 to extract the model" >&2
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
  if [[ ! -d "$dest/$name/am" ]]; then
    echo "hearth-vosk: archive did not contain $name/am" >&2
    return 1
  fi
  echo "hearth-vosk: model ready at $dest/$name"
}
