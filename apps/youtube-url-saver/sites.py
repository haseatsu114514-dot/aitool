from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True, slots=True)
class SiteProfile:
    key: str
    label: str
    audio_only: bool = False


YOUTUBE = SiteProfile("youtube", "YouTube")
NICONICO = SiteProfile("niconico", "ニコニコ動画")
SOUNDCLOUD = SiteProfile("soundcloud", "SoundCloud", audio_only=True)
UNKNOWN = SiteProfile("unknown", "URLを確認")


def _normalized_host(url: str) -> str:
    target = url.strip()
    if "://" not in target:
        target = f"https://{target}"

    parsed = urlparse(target)
    return parsed.netloc.lower().split(":", 1)[0].removeprefix("www.")


def _generic_site_profile(host: str) -> SiteProfile:
    if not host:
        return UNKNOWN
    return SiteProfile(f"host:{host}", host)


def detect_site(url: str) -> SiteProfile:
    host = _normalized_host(url)

    if host in {"youtube.com", "youtu.be", "youtube-nocookie.com"} or host.endswith(
        ".youtube.com"
    ):
        return YOUTUBE

    if host in {"nicovideo.jp", "nico.ms"} or host.endswith(".nicovideo.jp"):
        return NICONICO

    if host in {"soundcloud.com", "on.soundcloud.com"} or host.endswith(".soundcloud.com"):
        return SOUNDCLOUD

    return _generic_site_profile(host)
