#!/bin/zsh
set -e

cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

source .venv/bin/activate

if ! python -c "import yt_dlp, imageio_ffmpeg, certifi" >/dev/null 2>&1; then
  python -m pip install -r requirements.txt
fi

exec python main.py
