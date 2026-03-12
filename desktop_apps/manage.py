#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
REGISTRY_PATH = Path(__file__).resolve().parent / "apps.json"


def load_apps() -> list[dict[str, object]]:
    data = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return list(data["apps"])


def get_app(app_id: str) -> dict[str, object]:
    for app in load_apps():
        if app["id"] == app_id:
            return app
    available = ", ".join(app["id"] for app in load_apps())
    raise SystemExit(f"Unknown app id: {app_id}\nAvailable: {available}")


def resolve_repo_path(path_text: str) -> Path:
    return (ROOT_DIR / path_text).resolve()


def resolve_any_path(path_text: str) -> Path:
    expanded = os.path.expanduser(path_text)
    if os.path.isabs(expanded):
        return Path(expanded)
    return resolve_repo_path(path_text)


def git_state(source_dir: Path) -> str:
    if not source_dir.exists():
        return "missing"

    if source_dir == ROOT_DIR:
        status = subprocess.run(
            ["git", "status", "--short"],
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            check=False,
        )
        return "tracked-dirty" if status.stdout.strip() else "tracked"

    if not str(source_dir).startswith(str(ROOT_DIR)):
        if (source_dir / ".git").exists():
            return "external-git"
        return "external"

    if (source_dir / ".git").exists():
        return "nested-git"

    rel = source_dir.relative_to(ROOT_DIR)

    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", str(rel)],
        cwd=ROOT_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )

    status = subprocess.run(
        ["git", "status", "--short", "--", str(rel)],
        cwd=ROOT_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    dirty = bool(status.stdout.strip())

    if tracked.returncode == 0:
        return "tracked-dirty" if dirty else "tracked"

    return "untracked"


def desktop_state(desktop_path: Path) -> str:
    if desktop_path.exists():
        return "present"
    if desktop_path.is_symlink():
        return "broken-link"
    return "missing"


def get_command(app: dict[str, object], key: str) -> dict[str, str] | None:
    value = app.get(key)
    if not value:
        return None
    return value  # type: ignore[return-value]


def run_command(command_spec: dict[str, str], dry_run: bool) -> int:
    cwd = resolve_repo_path(command_spec["cwd"])
    command = command_spec["command"]

    print(f"$ (cd {cwd} && {command})")
    if dry_run:
        return 0

    completed = subprocess.run(
        ["/bin/zsh", "-lc", command],
        cwd=cwd,
        check=False,
    )
    return completed.returncode


def list_apps() -> int:
    apps = load_apps()

    rows: list[tuple[str, str, str, str, str]] = []
    for app in apps:
        source_dir = resolve_repo_path(str(app["source_dir"]))
        desktop_path = resolve_any_path(str(app["desktop_path"]))
        rows.append(
            (
                str(app["id"]),
                str(app["name"]),
                git_state(source_dir),
                desktop_state(desktop_path),
                str(app["source_dir"]),
            )
        )

    headers = ("ID", "Name", "Git", "Desktop", "Source")
    widths = [len(header) for header in headers]
    for row in rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))

    print(" ".join(header.ljust(widths[index]) for index, header in enumerate(headers)))
    print(" ".join("-" * width for width in widths))
    for row in rows:
        print(" ".join(cell.ljust(widths[index]) for index, cell in enumerate(row)))
    print()
    print("Git: tracked / tracked-dirty / untracked / nested-git / external-git / external / missing")
    return 0


def show_app(app_id: str) -> int:
    app = get_app(app_id)
    source_dir = resolve_repo_path(str(app["source_dir"]))
    desktop_path = resolve_any_path(str(app["desktop_path"]))

    print(f"id:           {app['id']}")
    print(f"name:         {app['name']}")
    print(f"tech:         {app['tech']}")
    print(f"source_dir:   {source_dir}")
    print(f"desktop_path: {desktop_path}")
    print(f"git_state:    {git_state(source_dir)}")
    print(f"desktop:      {desktop_state(desktop_path)}")

    build = get_command(app, "build")
    run = get_command(app, "run")

    print(f"build:        {build['command'] if build else '-'}")
    print(f"run:          {run['command'] if run else '-'}")
    print(f"notes:        {app['notes']}")
    return 0


def run_named_command(action: str, app_id: str, dry_run: bool) -> int:
    app = get_app(app_id)
    command_spec = get_command(app, action)
    if not command_spec:
        raise SystemExit(f"{app_id} does not define a '{action}' command.")
    return run_command(command_spec, dry_run)


def open_desktop(app_id: str, dry_run: bool) -> int:
    app = get_app(app_id)
    desktop_path = resolve_any_path(str(app["desktop_path"]))
    if not desktop_path.exists():
        raise SystemExit(f"Desktop entry not found: {desktop_path}")
    command_spec = {"cwd": ".", "command": f"open {json.dumps(str(desktop_path))}"}
    return run_command(command_spec, dry_run)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="デスクトップアプリをこの repo からまとめて確認・起動する管理 CLI"
    )
    subparsers = parser.add_subparsers(dest="subcommand", required=False)

    subparsers.add_parser("list", help="管理対象アプリを一覧表示")

    info_parser = subparsers.add_parser("info", help="1つのアプリの詳細を表示")
    info_parser.add_argument("app_id")

    build_parser = subparsers.add_parser("build", help="アプリの build/update コマンドを実行")
    build_parser.add_argument("app_id")
    build_parser.add_argument("--dry-run", action="store_true")

    run_parser = subparsers.add_parser("run", help="アプリの run コマンドを実行")
    run_parser.add_argument("app_id")
    run_parser.add_argument("--dry-run", action="store_true")

    open_parser = subparsers.add_parser("open-desktop", help="デスクトップ上のアプリを開く")
    open_parser.add_argument("app_id")
    open_parser.add_argument("--dry-run", action="store_true")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.subcommand in (None, "list"):
        return list_apps()
    if args.subcommand == "info":
        return show_app(args.app_id)
    if args.subcommand == "build":
        return run_named_command("build", args.app_id, args.dry_run)
    if args.subcommand == "run":
        return run_named_command("run", args.app_id, args.dry_run)
    if args.subcommand == "open-desktop":
        return open_desktop(args.app_id, args.dry_run)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
