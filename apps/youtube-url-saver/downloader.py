from __future__ import annotations

import os
import shutil
import stat
import sys
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

import certifi
import imageio_ffmpeg
import yt_dlp

from config import MAX_VIDEO_HEIGHT, MP3_BITRATE
from sites import detect_site


class SaveFormat(StrEnum):
    MP3 = "mp3"
    MP4 = "mp4"


@dataclass(slots=True)
class DownloadRequest:
    url: str
    output_dir: Path
    save_format: SaveFormat


ProgressCallback = Callable[[str], None]
CancelCallback = Callable[[], bool]
FormatResolvedCallback = Callable[[SaveFormat], None]


class DownloadError(RuntimeError):
    pass


class DownloadCancelled(DownloadError):
    pass


def _normalized_url_path(url: str) -> str:
    target = url.strip()
    if "://" not in target:
        target = f"https://{target}"
    return urlparse(target).path.strip("/")


def _humanize_download_error(url: str, message: str) -> str:
    normalized_message = message.removeprefix("ERROR: ").strip()
    lowered = normalized_message.lower()

    if "unsupported url" in lowered:
        if not _normalized_url_path(url):
            return (
                "このURLはサイトのトップページなので保存できません。"
                "動画や音声の個別ページURLを指定してください。"
            )
        return (
            "このURLは保存対象のメディアページとして認識できません。"
            "動画や音声の個別ページURLを指定してください。"
        )

    if "requested format is not available" in lowered:
        return (
            "このページでは選択した形式で保存できません。"
            "MP3とMP4を切り替えて試してください。"
        )

    if "login required" in lowered or "sign in" in lowered or "private video" in lowered:
        return (
            "このページはログインまたは権限が必要です。"
            "公開ページか、アクセス可能な個別URLを使ってください。"
        )

    if "http error 403" in lowered or "forbidden" in lowered:
        return "このURLへのアクセスが拒否されました。公開ページか権限を確認してください。"

    return normalized_message


def effective_save_format(url: str, requested_format: SaveFormat) -> SaveFormat:
    detected_site = detect_site(url)
    if detected_site.audio_only:
        return SaveFormat.MP3
    return requested_format


def _format_has_video(info: dict) -> bool:
    vcodec = info.get("vcodec")
    if vcodec and vcodec != "none":
        return True
    if any(info.get(key) not in (None, "none") for key in ("height", "width")):
        return True
    resolution = info.get("resolution")
    if resolution and resolution not in {"none", "audio only"}:
        return True
    return False


def _format_has_audio(info: dict) -> bool:
    acodec = info.get("acodec")
    if acodec and acodec != "none":
        return True
    audio_ext = info.get("audio_ext")
    if audio_ext and audio_ext != "none":
        return True
    return info.get("ext") in {"mp3", "m4a", "aac", "flac", "wav", "ogg", "opus"}


def _iter_media_variants(info: dict) -> list[dict]:
    variants: list[dict] = []

    entries = info.get("entries") or []
    for entry in entries:
        if isinstance(entry, dict):
            variants.extend(_iter_media_variants(entry))

    for key in ("requested_formats", "formats"):
        for item in info.get(key) or []:
            if isinstance(item, dict):
                variants.append(item)

    if not variants:
        variants.append(info)

    return variants


def _is_audio_only_info(info: dict) -> bool:
    variants = _iter_media_variants(info)
    has_video = any(_format_has_video(variant) for variant in variants)
    has_audio = any(_format_has_audio(variant) for variant in variants)
    return has_audio and not has_video


def _probe_audio_only(
    url: str,
    should_cancel: CancelCallback | None,
) -> bool:
    _configure_certificate_bundle()
    if should_cancel and should_cancel():
        raise DownloadCancelled("キャンセルしました。")

    probe_options = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
    }

    try:
        with yt_dlp.YoutubeDL(probe_options) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as error:
        if should_cancel and should_cancel():
            raise DownloadCancelled("キャンセルしました。") from error
        raise DownloadError(_humanize_download_error(url, str(error))) from error

    if should_cancel and should_cancel():
        raise DownloadCancelled("キャンセルしました。")

    return _is_audio_only_info(info)


def _resolve_save_format(
    request: DownloadRequest,
    should_cancel: CancelCallback | None,
) -> tuple[SaveFormat, str | None]:
    detected_site = detect_site(request.url)
    requested_format = request.save_format

    if detected_site.audio_only and requested_format != SaveFormat.MP3:
        return SaveFormat.MP3, f"{detected_site.label} を検出したため MP3 で保存します。"

    if requested_format == SaveFormat.MP4 and _probe_audio_only(request.url, should_cancel):
        return SaveFormat.MP3, "動画が見つからないため MP3 で保存します。"

    return requested_format, None


def _format_bytes(value: float) -> str:
    size = float(value)
    units = ["B", "KB", "MB", "GB", "TB"]
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}TB"


def _format_seconds(seconds: int | float) -> str:
    remaining = int(seconds)
    minutes, secs = divmod(remaining, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}時間{minutes}分{secs}秒"
    if minutes:
        return f"{minutes}分{secs}秒"
    return f"{secs}秒"


def _progress_message(data: dict) -> str | None:
    status = data.get("status")
    if status == "downloading":
        downloaded = data.get("downloaded_bytes") or 0
        total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
        speed = data.get("speed")
        eta = data.get("eta")
        parts = []
        if total:
            percent = downloaded / total * 100
            parts.append(f"ダウンロード中 {percent:.1f}%")
        else:
            parts.append(f"ダウンロード中 {_format_bytes(downloaded)}")
        if speed:
            parts.append(f"{_format_bytes(speed)}/秒")
        if eta is not None:
            parts.append(f"残り {_format_seconds(eta)}")
        return " | ".join(parts)
    if status == "finished":
        return "ダウンロード完了。変換を開始します。"
    if status == "error":
        return "ダウンロード中にエラーが発生しました。"
    return None


def _postprocessor_message(data: dict) -> str | None:
    status = data.get("status")
    processor = data.get("postprocessor", "")
    if status == "started" and processor == "FFmpegExtractAudio":
        return "MP3へ変換しています。"
    if status == "finished" and processor == "FFmpegExtractAudio":
        return "MP3変換が完了しました。"
    if status == "started":
        return "MP4を結合しています。"
    if status == "finished":
        return "最終ファイルを仕上げています。"
    return None


def _resolve_ffmpeg_exe() -> str:
    candidates: list[Path] = []

    env_path = os.environ.get("IMAGEIO_FFMPEG_EXE")
    if env_path:
        candidates.append(Path(env_path).expanduser())

    try:
        candidates.append(Path(imageio_ffmpeg.get_ffmpeg_exe()))
    except Exception:
        pass

    lib_roots = [
        Path(sys.prefix) / "lib",
        Path(sys.base_prefix) / "lib",
        Path(__file__).resolve().parent,
    ]
    for root in lib_roots:
        if not root.exists():
            continue
        candidates.extend(root.glob("python*/site-packages/imageio_ffmpeg/binaries/ffmpeg-*"))
        candidates.extend(root.glob("imageio_ffmpeg/binaries/ffmpeg-*"))

    which_ffmpeg = shutil.which("ffmpeg")
    if which_ffmpeg:
        candidates.append(Path(which_ffmpeg))

    seen: set[Path] = set()
    for candidate in candidates:
        candidate = candidate.resolve()
        if candidate in seen or not candidate.exists() or candidate.is_dir():
            continue
        seen.add(candidate)
        current_mode = candidate.stat().st_mode
        if not os.access(candidate, os.X_OK):
            candidate.chmod(current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        if os.access(candidate, os.X_OK):
            os.environ["IMAGEIO_FFMPEG_EXE"] = str(candidate)
            return str(candidate)

    raise DownloadError(
        "ffmpeg を見つけられませんでした。アプリを再起動しても直らない場合は、作り直した最新版へ入れ替えてください。"
    )


def _configure_certificate_bundle() -> None:
    cert_path = certifi.where()
    os.environ["SSL_CERT_FILE"] = cert_path
    os.environ["REQUESTS_CA_BUNDLE"] = cert_path
    os.environ["CURL_CA_BUNDLE"] = cert_path


def _build_options(
    request: DownloadRequest,
    progress_callback: ProgressCallback | None,
    should_cancel: CancelCallback | None,
) -> dict:
    _configure_certificate_bundle()
    ffmpeg_path = _resolve_ffmpeg_exe()

    def ensure_not_cancelled() -> None:
        if should_cancel and should_cancel():
            raise DownloadCancelled("キャンセルしました。")

    def emit(message: str | None) -> None:
        if message and progress_callback:
            progress_callback(message)

    def progress_hook(data: dict) -> None:
        ensure_not_cancelled()
        emit(_progress_message(data))

    def postprocessor_hook(data: dict) -> None:
        ensure_not_cancelled()
        emit(_postprocessor_message(data))

    options = {
        "ffmpeg_location": ffmpeg_path,
        "noplaylist": True,
        "outtmpl": str(request.output_dir / "%(title)s [%(id)s].%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [postprocessor_hook],
    }

    if request.save_format == SaveFormat.MP3:
        options["format"] = "bestaudio/best"
        options["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": MP3_BITRATE,
            }
        ]
    else:
        capped_mp4 = (
            f"bestvideo[ext=mp4][height<={MAX_VIDEO_HEIGHT}]"
            f"+bestaudio[ext=m4a]"
            f"/best[ext=mp4][height<={MAX_VIDEO_HEIGHT}]"
            f"/bestvideo[height<={MAX_VIDEO_HEIGHT}]+bestaudio"
            f"/best[height<={MAX_VIDEO_HEIGHT}]"
        )
        options["format"] = capped_mp4
        options["merge_output_format"] = "mp4"

    return options


def download_media(
    request: DownloadRequest,
    progress_callback: ProgressCallback | None = None,
    should_cancel: CancelCallback | None = None,
    format_resolved_callback: FormatResolvedCallback | None = None,
) -> Path:
    if not request.url.strip():
        raise DownloadError("URLを入力してください。")

    save_format, auto_message = _resolve_save_format(request, should_cancel)
    if format_resolved_callback and save_format != request.save_format:
        format_resolved_callback(save_format)

    request.output_dir.mkdir(parents=True, exist_ok=True)
    adjusted_request = DownloadRequest(
        url=request.url,
        output_dir=request.output_dir,
        save_format=save_format,
    )
    options = _build_options(adjusted_request, progress_callback, should_cancel)

    if should_cancel and should_cancel():
        raise DownloadCancelled("キャンセルしました。")

    if progress_callback:
        if auto_message:
            progress_callback(auto_message)

        if save_format == SaveFormat.MP3:
            progress_callback("MP3 320kbpsで保存を開始します。")
        else:
            progress_callback(f"MP4 最大{MAX_VIDEO_HEIGHT}pで保存を開始します。")

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            if should_cancel and should_cancel():
                raise DownloadCancelled("キャンセルしました。")
            info = ydl.extract_info(request.url, download=True)
            final_path = Path(ydl.prepare_filename(info))
    except DownloadCancelled:
        raise
    except yt_dlp.utils.DownloadError as error:
        if should_cancel and should_cancel():
            raise DownloadCancelled("キャンセルしました。") from error
        raise DownloadError(_humanize_download_error(request.url, str(error))) from error
    except Exception as error:
        if should_cancel and should_cancel():
            raise DownloadCancelled("キャンセルしました。") from error
        raise DownloadError(f"保存に失敗しました: {error}") from error

    expected_extension = ".mp3" if save_format == SaveFormat.MP3 else ".mp4"
    final_path = final_path.with_suffix(expected_extension)
    if final_path.exists():
        return final_path

    candidates = sorted(
        request.output_dir.glob(f"{final_path.stem}.*"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for candidate in candidates:
        if candidate.suffix.lower() == expected_extension:
            return candidate

    raise DownloadError("保存は完了しましたが、出力ファイルを特定できませんでした。")
