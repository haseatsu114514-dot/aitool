from datetime import datetime
from pathlib import Path

APP_NAME = "Media URL Saver"
APP_SITES_LABEL = "幅広い動画・音声サイト"


def build_default_output_dir() -> Path:
    today = datetime.now().astimezone().strftime("%Y-%m-%d")
    return Path.home() / "Desktop" / today


DEFAULT_OUTPUT_DIR = build_default_output_dir()
MAX_VIDEO_HEIGHT = 1080
MP3_BITRATE = "320"
MAX_TASKS = 10
MAX_PARALLEL_DOWNLOADS = 2
START_IN_COMPACT_MODE = True
