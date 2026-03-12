from __future__ import annotations

import plistlib
import shutil
import stat
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

from config import APP_NAME

ROOT_DIR = Path(__file__).resolve().parent
BUILD_DIR = ROOT_DIR / "build"
DESKTOP_APP_DIR = Path.home() / "Desktop" / f"{APP_NAME}.app"
LEGACY_APP_DIRS = [
    Path.home() / "Desktop" / "YouTube URL Saver.app",
]


def create_base_icon(size: int = 1024) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    shadow_offset = int(size * 0.024)
    base_shadow = (
        int(size * 0.12) + shadow_offset,
        int(size * 0.12) + shadow_offset,
        int(size * 0.84) + shadow_offset,
        int(size * 0.84) + shadow_offset,
    )
    draw.rounded_rectangle(base_shadow, radius=int(size * 0.18), fill=(22, 33, 44, 45))

    base_box = (
        int(size * 0.12),
        int(size * 0.12),
        int(size * 0.84),
        int(size * 0.84),
    )
    draw.rounded_rectangle(
        base_box,
        radius=int(size * 0.18),
        fill=(246, 241, 232, 255),
        outline=(255, 255, 255, 230),
        width=int(size * 0.008),
    )

    bar_shadow = (
        int(size * 0.20) + shadow_offset,
        int(size * 0.28) + shadow_offset,
        int(size * 0.74) + shadow_offset,
        int(size * 0.49) + shadow_offset,
    )
    draw.rounded_rectangle(bar_shadow, radius=int(size * 0.08), fill=(10, 28, 44, 40))

    url_bar = (
        int(size * 0.20),
        int(size * 0.28),
        int(size * 0.74),
        int(size * 0.49),
    )
    draw.rounded_rectangle(url_bar, radius=int(size * 0.08), fill=(41, 63, 84, 255))

    dot_y = int(size * 0.385)
    for index, offset in enumerate([0.26, 0.31, 0.36]):
        fill = (255, 255, 255, 200 if index == 0 else 150)
        draw.ellipse(
            (
                int(size * offset),
                dot_y - int(size * 0.018),
                int(size * offset) + int(size * 0.036),
                dot_y + int(size * 0.018),
            ),
            fill=fill,
        )

    link_color = (255, 255, 255, 255)
    stroke = int(size * 0.018)
    draw.rounded_rectangle(
        (
            int(size * 0.43),
            int(size * 0.335),
            int(size * 0.53),
            int(size * 0.435),
        ),
        radius=int(size * 0.045),
        outline=link_color,
        width=stroke,
    )
    draw.rounded_rectangle(
        (
            int(size * 0.50),
            int(size * 0.335),
            int(size * 0.60),
            int(size * 0.435),
        ),
        radius=int(size * 0.045),
        outline=link_color,
        width=stroke,
    )

    caption_color = (122, 112, 98, 255)
    for offset in [0.58, 0.65]:
        draw.rounded_rectangle(
            (
                int(size * 0.24),
                int(size * offset),
                int(size * 0.56),
                int(size * (offset + 0.03)),
            ),
            radius=int(size * 0.012),
            fill=caption_color,
        )

    badge_shadow = (
        int(size * 0.56) + shadow_offset,
        int(size * 0.54) + shadow_offset,
        int(size * 0.86) + shadow_offset,
        int(size * 0.84) + shadow_offset,
    )
    draw.ellipse(badge_shadow, fill=(17, 84, 83, 52))

    badge_box = (
        int(size * 0.54),
        int(size * 0.52),
        int(size * 0.84),
        int(size * 0.82),
    )
    draw.ellipse(
        badge_box,
        fill=(29, 148, 141, 255),
        outline=(255, 255, 255, 220),
        width=int(size * 0.012),
    )

    arrow_width = int(size * 0.038)
    draw.line(
        [
            (int(size * 0.69), int(size * 0.58)),
            (int(size * 0.69), int(size * 0.70)),
        ],
        fill=(255, 255, 255, 255),
        width=arrow_width,
    )
    draw.polygon(
        [
            (int(size * 0.62), int(size * 0.67)),
            (int(size * 0.76), int(size * 0.67)),
            (int(size * 0.69), int(size * 0.77)),
        ],
        fill=(255, 255, 255, 255),
    )
    draw.rounded_rectangle(
        (
            int(size * 0.61),
            int(size * 0.77),
            int(size * 0.77),
            int(size * 0.81),
        ),
        radius=int(size * 0.02),
        fill=(255, 255, 255, 255),
    )

    return image


def build_icon() -> Path:
    iconset_dir = BUILD_DIR / "AppIcon.iconset"
    icns_path = BUILD_DIR / "AppIcon.icns"
    if iconset_dir.exists():
        shutil.rmtree(iconset_dir)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    iconset_dir.mkdir()

    base_icon = create_base_icon()
    icon_sizes = [16, 32, 128, 256, 512]
    for size in icon_sizes:
        base_icon.resize((size, size), Image.LANCZOS).save(
            iconset_dir / f"icon_{size}x{size}.png"
        )
        retina = size * 2
        base_icon.resize((retina, retina), Image.LANCZOS).save(
            iconset_dir / f"icon_{size}x{size}@2x.png"
        )

    subprocess.run(["iconutil", "-c", "icns", str(iconset_dir), "-o", str(icns_path)], check=True)
    return icns_path


def build_launcher_script(target: Path) -> None:
    script = """#!/bin/zsh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
cd "$APP_DIR"

if [ ! -d ".venv" ]; then
  /usr/bin/python3 -m venv .venv
fi

source .venv/bin/activate

if ! python -c "import yt_dlp, imageio_ffmpeg, certifi" >/dev/null 2>&1; then
  python -m pip install -r requirements.txt >/tmp/media-url-saver-install.log 2>&1 || {
    /usr/bin/osascript -e 'display alert "セットアップに失敗しました" message "詳しくは /tmp/media-url-saver-install.log を確認してください。"' || true
    exit 1
  }
fi

FFMPEG_EXE="$(find "$APP_DIR/.venv/lib" -path '*imageio_ffmpeg/binaries/ffmpeg-*' -type f | head -n 1)"
if [ -n "$FFMPEG_EXE" ]; then
  chmod +x "$FFMPEG_EXE" || true
  export IMAGEIO_FFMPEG_EXE="$FFMPEG_EXE"
fi

exec python main.py
"""
    target.write_text(script, encoding="utf-8")
    current_mode = target.stat().st_mode
    target.chmod(current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def write_info_plist(target: Path) -> None:
    info = {
        "CFBundleDevelopmentRegion": "ja",
        "CFBundleDisplayName": APP_NAME,
        "CFBundleExecutable": APP_NAME,
        "CFBundleIconFile": "AppIcon",
        "CFBundleIdentifier": "local.codex.media-url-saver",
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": APP_NAME,
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "1.0.0",
        "CFBundleVersion": "1",
        "LSMinimumSystemVersion": "12.0",
        "NSHighResolutionCapable": True,
    }
    with target.open("wb") as file:
        plistlib.dump(info, file)


def copy_source_files(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for filename in [
        "app.py",
        "config.py",
        "downloader.py",
        "main.py",
        "sites.py",
        "requirements.txt",
        "README.md",
    ]:
        shutil.copy2(ROOT_DIR / filename, destination / filename)


def create_bundle(icns_path: Path) -> Path:
    for legacy_dir in LEGACY_APP_DIRS:
        if legacy_dir.exists():
            shutil.rmtree(legacy_dir)

    if DESKTOP_APP_DIR.exists():
        shutil.rmtree(DESKTOP_APP_DIR)

    contents_dir = DESKTOP_APP_DIR / "Contents"
    macos_dir = contents_dir / "MacOS"
    resources_dir = contents_dir / "Resources"
    app_resources_dir = resources_dir / "app"

    macos_dir.mkdir(parents=True, exist_ok=True)
    app_resources_dir.mkdir(parents=True, exist_ok=True)

    write_info_plist(contents_dir / "Info.plist")
    shutil.copy2(icns_path, resources_dir / "AppIcon.icns")
    build_launcher_script(macos_dir / APP_NAME)
    copy_source_files(app_resources_dir)

    return DESKTOP_APP_DIR


def install_runtime_dependencies(app_dir: Path) -> None:
    app_resources_dir = app_dir / "Contents" / "Resources" / "app"
    subprocess.run(["python3", "-m", "venv", ".venv"], cwd=app_resources_dir, check=True)
    subprocess.run(
        ["./.venv/bin/python", "-m", "pip", "install", "-r", "requirements.txt"],
        cwd=app_resources_dir,
        check=True,
    )


def main() -> None:
    icns_path = build_icon()
    app_dir = create_bundle(icns_path)
    install_runtime_dependencies(app_dir)
    print(app_dir)


if __name__ == "__main__":
    main()
