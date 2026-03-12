from __future__ import annotations

import argparse
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from app import run_app
from config import DEFAULT_OUTPUT_DIR, MAX_PARALLEL_DOWNLOADS, MAX_TASKS
from downloader import DownloadError, DownloadRequest, SaveFormat, download_media
from downloader import effective_save_format
from sites import detect_site


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "入力したURL先をMP3またはMP4で保存します。"
            "主要サイトは自動判別し、それ以外も yt-dlp が対応していればそのまま保存します。"
            "動画がないURLは自動で MP3 に切り替えます。"
        )
    )
    parser.add_argument("urls", nargs="*", help="保存したいURL")
    parser.add_argument(
        "--format",
        choices=[SaveFormat.MP3.value, SaveFormat.MP4.value],
        default=SaveFormat.MP3.value,
        help="保存形式",
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_DIR),
        help="保存先フォルダ",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=MAX_PARALLEL_DOWNLOADS,
        help="CLIでの同時実行数",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if not args.urls:
        run_app()
        return 0

    urls = [url.strip() for url in args.urls if url.strip()]
    if len(urls) > MAX_TASKS:
        parser.error(f"一度に指定できるURLは最大{MAX_TASKS}件です。")

    jobs = max(1, min(args.jobs, len(urls), MAX_TASKS))
    output_dir = Path(args.output_dir).expanduser()
    save_format = SaveFormat(args.format)
    print_lock = threading.Lock()

    def log(message: str, error: bool = False) -> None:
        target = sys.stderr if error else sys.stdout
        with print_lock:
            print(message, file=target)

    def run_single(index: int, url: str) -> Path:
        prefix = f"[{index + 1}/{len(urls)}]"
        detected_site = detect_site(url)
        effective_format = effective_save_format(url, save_format)
        if effective_format != save_format:
            log(f"{prefix} {detected_site.label} を検出したため MP3 に切り替えます。")
        request = DownloadRequest(
            url=url,
            output_dir=output_dir,
            save_format=effective_format,
        )
        return download_media(
            request,
            progress_callback=lambda message: log(f"{prefix} {message}"),
        )

    exit_code = 0
    with ThreadPoolExecutor(max_workers=jobs) as executor:
        futures = {
            executor.submit(run_single, index, url): (index, url)
            for index, url in enumerate(urls)
        }
        for future in as_completed(futures):
            index, _url = futures[future]
            prefix = f"[{index + 1}/{len(urls)}]"
            try:
                saved_path = future.result()
            except DownloadError as error:
                exit_code = 1
                log(f"{prefix} エラー: {error}", error=True)
                continue
            except Exception as error:
                exit_code = 1
                log(f"{prefix} 想定外のエラー: {error}", error=True)
                continue

            log(f"{prefix} 保存完了: {saved_path}")

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
