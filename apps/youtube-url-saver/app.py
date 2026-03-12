from __future__ import annotations

import subprocess
import threading
import tkinter as tk
from dataclasses import dataclass, field
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from config import (
    APP_NAME,
    APP_SITES_LABEL,
    DEFAULT_OUTPUT_DIR,
    MAX_PARALLEL_DOWNLOADS,
    MAX_TASKS,
    MAX_VIDEO_HEIGHT,
    MP3_BITRATE,
    START_IN_COMPACT_MODE,
)
from downloader import (
    DownloadCancelled,
    DownloadError,
    DownloadRequest,
    SaveFormat,
    download_media,
    effective_save_format,
)
from sites import detect_site


STATUS_WAITING = "待機中"
STATUS_RUNNING = "実行中"
STATUS_CANCELLING = "取消中"
STATUS_CANCELLED = "キャンセル"
STATUS_DONE = "完了"
STATUS_ERROR = "失敗"


@dataclass(slots=True)
class DownloadTask:
    task_id: int
    request: DownloadRequest
    status: str = STATUS_WAITING
    detail: str = "実行待ちです。"
    cancel_event: threading.Event = field(default_factory=threading.Event)


class UrlSaverApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(APP_NAME)
        self.root.protocol("WM_DELETE_WINDOW", self._close_app)
        self.style = ttk.Style(self.root)

        self.url_var = tk.StringVar()
        self.output_dir_var = tk.StringVar(value=str(DEFAULT_OUTPUT_DIR))
        self.format_var = tk.StringVar(value=SaveFormat.MP3.value)
        self.compact_output_summary_var = tk.StringVar()
        self.site_summary_var = tk.StringVar(value="判定: URL先のサイトを自動判定")
        self.status_var = tk.StringVar(
            value=(
                f"URLを追加してください。最大{MAX_TASKS}件まで保持し、"
                f"{MAX_PARALLEL_DOWNLOADS}件ずつ並行保存します。"
            )
        )
        self.tasks: dict[int, DownloadTask] = {}
        self.next_task_id = 1
        self._closed = False
        self._compact_mode = START_IN_COMPACT_MODE
        self._download_slots = threading.Semaphore(MAX_PARALLEL_DOWNLOADS)

        DEFAULT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        self._configure_styles()
        self._build_ui()
        self.url_var.trace_add("write", self._refresh_controls)
        self.url_var.trace_add("write", self._refresh_site_summary)
        self.output_dir_var.trace_add("write", self._refresh_compact_output_summary)
        self._refresh_compact_output_summary()
        self._refresh_site_summary()
        self._apply_layout_mode()
        self._refresh_controls()

    def _configure_styles(self) -> None:
        self.style.configure("CompactTitle.TLabel", font=("Helvetica Neue", 20, "bold"))
        self.style.configure("CompactMeta.TLabel", font=("Helvetica Neue", 13))
        self.style.configure("Compact.TRadiobutton", font=("Helvetica Neue", 13, "bold"))
        self.style.configure("CompactPrimary.TButton", font=("Helvetica Neue", 14, "bold"))
        self.style.configure("CompactSecondary.TButton", font=("Helvetica Neue", 13))

    def _build_ui(self) -> None:
        self.full_frame = ttk.Frame(self.root, padding=16)
        self.full_frame.columnconfigure(0, weight=1)

        self.compact_frame = ttk.Frame(self.root, padding=16)
        self.compact_frame.columnconfigure(0, weight=1)

        self._build_full_ui(self.full_frame)
        self._build_compact_ui(self.compact_frame)

        self.root.bind("<Return>", lambda _event: self._add_task_from_entry())

    def _build_full_ui(self, frame: ttk.Frame) -> None:
        header = ttk.Frame(frame)
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(0, weight=1)

        title = ttk.Label(
            header,
            text=APP_NAME,
            font=("Helvetica Neue", 24, "bold"),
        )
        title.grid(row=0, column=0, sticky="w")

        compact_button = ttk.Button(header, text="コンパクト", command=self._toggle_compact_mode)
        compact_button.grid(row=0, column=1, sticky="e")

        subtitle = ttk.Label(
            frame,
            text=(
                f"入力したURL先を自動判定し、MP3({MP3_BITRATE}kbps) または MP4(最大{MAX_VIDEO_HEIGHT}p) "
                f"として保存します。動画のないURLは自動で MP3 に切り替えます。"
            ),
        )
        subtitle.grid(row=1, column=0, sticky="w", pady=(6, 18))

        url_label = ttk.Label(frame, text="URL")
        url_label.grid(row=2, column=0, sticky="w")

        url_row = ttk.Frame(frame)
        url_row.grid(row=3, column=0, sticky="ew", pady=(6, 14))
        url_row.columnconfigure(0, weight=1)

        self.full_url_entry = ttk.Entry(url_row, textvariable=self.url_var)
        self.full_url_entry.grid(row=0, column=0, sticky="ew")

        paste_button = ttk.Button(url_row, text="貼り付け", command=self._paste_url)
        paste_button.grid(row=0, column=1, padx=(8, 0))

        self.full_add_button = ttk.Button(
            url_row, text="タスク追加", command=self._add_task_from_entry
        )
        self.full_add_button.grid(row=0, column=2, padx=(8, 0))

        self.full_site_label = ttk.Label(
            url_row,
            textvariable=self.site_summary_var,
            foreground="#55606d",
        )
        self.full_site_label.grid(row=1, column=0, columnspan=3, sticky="w", pady=(8, 0))

        format_label = ttk.Label(frame, text="保存形式")
        format_label.grid(row=4, column=0, sticky="w")

        format_row = ttk.Frame(frame)
        format_row.grid(row=5, column=0, sticky="w", pady=(6, 14))

        self.full_mp3_radio = ttk.Radiobutton(
            format_row,
            text=f"MP3 ({MP3_BITRATE}kbps)",
            value=SaveFormat.MP3.value,
            variable=self.format_var,
        )
        self.full_mp3_radio.grid(row=0, column=0, padx=(0, 12))

        self.full_mp4_radio = ttk.Radiobutton(
            format_row,
            text=f"MP4 (最大{MAX_VIDEO_HEIGHT}p)",
            value=SaveFormat.MP4.value,
            variable=self.format_var,
        )
        self.full_mp4_radio.grid(row=0, column=1)

        output_label = ttk.Label(frame, text="保存先フォルダ")
        output_label.grid(row=6, column=0, sticky="w")

        output_row = ttk.Frame(frame)
        output_row.grid(row=7, column=0, sticky="ew", pady=(6, 14))
        output_row.columnconfigure(0, weight=1)

        output_entry = ttk.Entry(output_row, textvariable=self.output_dir_var)
        output_entry.grid(row=0, column=0, sticky="ew")

        choose_button = ttk.Button(
            output_row, text="選ぶ", command=self._choose_output_dir
        )
        choose_button.grid(row=0, column=1, padx=(8, 0))

        action_row = ttk.Frame(frame)
        action_row.grid(row=8, column=0, sticky="w", pady=(0, 14))

        self.cancel_button = ttk.Button(
            action_row, text="選択タスクをキャンセル", command=self._cancel_selected_tasks
        )
        self.cancel_button.grid(row=0, column=0, padx=(0, 8))

        self.clear_button = ttk.Button(
            action_row, text="完了タスクを消す", command=self._clear_finished_tasks
        )
        self.clear_button.grid(row=0, column=1, padx=(0, 8))

        ttk.Button(action_row, text="保存先を開く", command=self._open_output_dir).grid(
            row=0, column=2, padx=(0, 8)
        )

        ttk.Button(action_row, text="選択した履歴を削除", command=self._remove_selected_task).grid(
            row=0, column=3
        )

        queue_label = ttk.Label(frame, text="タスク一覧")
        queue_label.grid(row=9, column=0, sticky="w")

        queue_frame = ttk.Frame(frame)
        queue_frame.grid(row=10, column=0, sticky="nsew", pady=(6, 14))
        queue_frame.columnconfigure(0, weight=1)

        columns = ("status", "format", "source", "detail")
        self.task_tree = ttk.Treeview(
            queue_frame,
            columns=columns,
            show="headings",
            height=8,
        )
        self.task_tree.heading("status", text="状態")
        self.task_tree.heading("format", text="形式")
        self.task_tree.heading("source", text="URL")
        self.task_tree.heading("detail", text="詳細")
        self.task_tree.column("status", width=90, anchor="center")
        self.task_tree.column("format", width=90, anchor="center")
        self.task_tree.column("source", width=320)
        self.task_tree.column("detail", width=340)
        self.task_tree.grid(row=0, column=0, sticky="nsew")

        tree_scrollbar = ttk.Scrollbar(
            queue_frame, orient="vertical", command=self.task_tree.yview
        )
        tree_scrollbar.grid(row=0, column=1, sticky="ns")
        self.task_tree.configure(yscrollcommand=tree_scrollbar.set)

        ttk.Label(frame, textvariable=self.status_var).grid(row=11, column=0, sticky="w")

        self.progress = ttk.Progressbar(frame, mode="indeterminate")
        self.progress.grid(row=12, column=0, sticky="ew", pady=(8, 14))

        ttk.Label(frame, text="ログ").grid(row=13, column=0, sticky="w")

        self.log = tk.Text(frame, height=12, wrap="word")
        self.log.grid(row=14, column=0, sticky="nsew", pady=(6, 14))
        frame.rowconfigure(14, weight=1)

        footer = ttk.Label(
            frame,
            text="利用権限のある動画のみ保存してください。",
            foreground="#666666",
        )
        footer.grid(row=15, column=0, sticky="w")

    def _build_compact_ui(self, frame: ttk.Frame) -> None:
        header = ttk.Frame(frame)
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(0, weight=1)

        title = ttk.Label(
            header,
            text=APP_NAME,
            style="CompactTitle.TLabel",
        )
        title.grid(row=0, column=0, sticky="w")

        ttk.Button(
            header,
            text="詳細",
            command=self._toggle_compact_mode,
            style="CompactSecondary.TButton",
        ).grid(row=0, column=1, sticky="e")

        ttk.Label(
            frame,
            text=f"{APP_SITES_LABEL} を自動判定",
            foreground="#55606d",
            style="CompactMeta.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(6, 0))

        compact_card = ttk.Frame(frame, padding=(0, 14, 0, 0))
        compact_card.grid(row=2, column=0, sticky="ew")
        compact_card.columnconfigure(0, weight=1)

        self.compact_url_entry = tk.Entry(
            compact_card,
            textvariable=self.url_var,
            font=("Helvetica Neue", 15),
            relief="solid",
            bd=1,
            highlightthickness=0,
        )
        self.compact_url_entry.grid(row=0, column=0, sticky="ew")

        ttk.Label(
            compact_card,
            textvariable=self.site_summary_var,
            foreground="#55606d",
            style="CompactMeta.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(8, 0))

        compact_output_row = ttk.Frame(compact_card)
        compact_output_row.grid(row=2, column=0, sticky="ew", pady=(10, 0))
        compact_output_row.columnconfigure(0, weight=1)

        ttk.Label(
            compact_output_row,
            textvariable=self.compact_output_summary_var,
            foreground="#555555",
            style="CompactMeta.TLabel",
        ).grid(row=0, column=0, sticky="w")

        ttk.Button(
            compact_output_row,
            text="保存先",
            command=self._choose_output_dir,
            style="CompactSecondary.TButton",
        ).grid(row=0, column=1, padx=(8, 0))

        action_row = ttk.Frame(compact_card)
        action_row.grid(row=3, column=0, sticky="w", pady=(12, 0))

        self.compact_mp3_radio = ttk.Radiobutton(
            action_row,
            text="MP3",
            value=SaveFormat.MP3.value,
            variable=self.format_var,
            style="Compact.TRadiobutton",
        )
        self.compact_mp3_radio.grid(row=0, column=0, padx=(0, 12))

        self.compact_mp4_radio = ttk.Radiobutton(
            action_row,
            text="MP4",
            value=SaveFormat.MP4.value,
            variable=self.format_var,
            style="Compact.TRadiobutton",
        )
        self.compact_mp4_radio.grid(row=0, column=1, padx=(0, 12))

        self.compact_add_button = ttk.Button(
            action_row,
            text="変換",
            command=self._add_task_from_entry,
            style="CompactPrimary.TButton",
        )
        self.compact_add_button.grid(row=0, column=2)

        self.compact_cancel_button = ttk.Button(
            action_row,
            text="最新取消",
            command=self._cancel_latest_active_task,
            style="CompactSecondary.TButton",
        )
        self.compact_cancel_button.grid(row=0, column=3, padx=(10, 0))

        compact_queue_label = ttk.Label(
            frame,
            text="タスク一覧",
            style="CompactMeta.TLabel",
        )
        compact_queue_label.grid(row=4, column=0, sticky="w", pady=(14, 0))

        compact_queue_frame = ttk.Frame(frame)
        compact_queue_frame.grid(row=5, column=0, sticky="nsew", pady=(8, 0))
        compact_queue_frame.columnconfigure(0, weight=1)
        frame.rowconfigure(5, weight=1)

        compact_columns = ("status", "format", "source", "detail")
        self.compact_task_tree = ttk.Treeview(
            compact_queue_frame,
            columns=compact_columns,
            show="headings",
            height=5,
        )
        self.compact_task_tree.heading("status", text="状態")
        self.compact_task_tree.heading("format", text="形式")
        self.compact_task_tree.heading("source", text="URL")
        self.compact_task_tree.heading("detail", text="詳細")
        self.compact_task_tree.column("status", width=72, anchor="center")
        self.compact_task_tree.column("format", width=56, anchor="center")
        self.compact_task_tree.column("source", width=170)
        self.compact_task_tree.column("detail", width=150)
        self.compact_task_tree.grid(row=0, column=0, sticky="nsew")

        compact_tree_scrollbar = ttk.Scrollbar(
            compact_queue_frame,
            orient="vertical",
            command=self.compact_task_tree.yview,
        )
        compact_tree_scrollbar.grid(row=0, column=1, sticky="ns")
        self.compact_task_tree.configure(yscrollcommand=compact_tree_scrollbar.set)

        ttk.Label(
            frame,
            textvariable=self.status_var,
            wraplength=500,
            foreground="#555555",
            style="CompactMeta.TLabel",
        ).grid(row=6, column=0, sticky="w", pady=(14, 0))

    def _toggle_compact_mode(self) -> None:
        self._compact_mode = not self._compact_mode
        self._apply_layout_mode()

    def _apply_layout_mode(self) -> None:
        if self._compact_mode:
            self.full_frame.pack_forget()
            self.compact_frame.pack(fill="both", expand=True)
            self.root.geometry("560x430")
            self.root.minsize(470, 340)
            self.compact_url_entry.focus_set()
            return

        self.compact_frame.pack_forget()
        self.full_frame.pack(fill="both", expand=True)
        self.root.geometry("920x700")
        self.root.minsize(760, 620)
        self.full_url_entry.focus_set()

    def _close_app(self) -> None:
        self._closed = True
        self.root.destroy()

    def _schedule_ui(self, callback, *args) -> None:
        if self._closed:
            return
        try:
            self.root.after(0, callback, *args)
        except RuntimeError:
            return

    def _refresh_controls(self, *_args) -> None:
        active_tasks = self._active_task_count()
        input_has_url = bool(self.url_var.get().strip())
        add_enabled = input_has_url and active_tasks < MAX_TASKS
        clear_enabled = any(
            task.status in {STATUS_DONE, STATUS_ERROR, STATUS_CANCELLED}
            for task in self.tasks.values()
        )
        cancel_enabled = any(
            task.status in {STATUS_WAITING, STATUS_RUNNING}
            for task in self.tasks.values()
        )
        button_state = "normal" if add_enabled else "disabled"
        self.full_add_button.config(state=button_state)
        self.compact_add_button.config(state=button_state)
        self.clear_button.config(state="normal" if clear_enabled else "disabled")
        self.cancel_button.config(state="normal" if cancel_enabled else "disabled")
        self.compact_cancel_button.config(state="normal" if cancel_enabled else "disabled")

    def _refresh_site_summary(self, *_args) -> None:
        urls = self._parse_urls()
        if not urls:
            self.site_summary_var.set("判定: URL先のサイトを自動判定")
            self.full_mp4_radio.config(state="normal")
            self.compact_mp4_radio.config(state="normal")
            return

        detected_sites = [detect_site(url) for url in urls]
        audio_only_count = sum(1 for site in detected_sites if site.audio_only)
        counts: dict[str, int] = {}
        labels: dict[str, str] = {}
        for site in detected_sites:
            counts[site.key] = counts.get(site.key, 0) + 1
            labels[site.key] = site.label

        if len(counts) == 1:
            site = detected_sites[0]
            summary = f"判定: {site.label}"
            if site.audio_only:
                summary = f"{summary} | 音声のみのため MP3 へ自動設定"
        else:
            parts = [f"{labels[key]} {counts[key]}件" for key in counts]
            summary = f"判定: {' / '.join(parts)}"
            if audio_only_count:
                summary = f"{summary} | 音声のみのURLは MP3 で保存"

        self.site_summary_var.set(summary)

        only_audio_sites = audio_only_count == len(urls)
        if only_audio_sites and self.format_var.get() != SaveFormat.MP3.value:
            self.format_var.set(SaveFormat.MP3.value)

        mp4_state = "disabled" if only_audio_sites else "normal"
        self.full_mp4_radio.config(state=mp4_state)
        self.compact_mp4_radio.config(state=mp4_state)

    def _refresh_compact_output_summary(self, *_args) -> None:
        output_dir = Path(self.output_dir_var.get()).expanduser()
        label = output_dir.name or str(output_dir)
        self.compact_output_summary_var.set(f"保存先: {self._shorten(label, 28)}")

    def _set_status(self, message: str) -> None:
        self.status_var.set(message)

    def _append_log(self, message: str) -> None:
        self.log.insert("end", f"{message}\n")
        self.log.see("end")

    def _shorten(self, text: str, limit: int = 56) -> str:
        if len(text) <= limit:
            return text
        return f"{text[: limit - 1]}…"

    def _active_task_count(self) -> int:
        return sum(
            1
            for task in self.tasks.values()
            if task.status in {STATUS_WAITING, STATUS_RUNNING, STATUS_CANCELLING}
        )

    def _refresh_status_summary(self, message: str | None = None) -> None:
        running = sum(1 for task in self.tasks.values() if task.status == STATUS_RUNNING)
        waiting = sum(1 for task in self.tasks.values() if task.status == STATUS_WAITING)
        cancelling = sum(1 for task in self.tasks.values() if task.status == STATUS_CANCELLING)
        completed = sum(1 for task in self.tasks.values() if task.status == STATUS_DONE)
        failed = sum(1 for task in self.tasks.values() if task.status == STATUS_ERROR)
        cancelled = sum(1 for task in self.tasks.values() if task.status == STATUS_CANCELLED)
        summary = (
            f"実行中 {running}件 / 待機 {waiting}件 / 取消中 {cancelling}件 / "
            f"完了 {completed}件 / 失敗 {failed}件 / キャンセル {cancelled}件"
        )
        if message:
            summary = f"{summary} | {message}"
        self._set_status(summary)
        if running or waiting or cancelling:
            self.progress.start(8)
        else:
            self.progress.stop()
        self._refresh_controls()

    def _delete_task_row(self, task_id: int) -> None:
        item_id = str(task_id)
        for tree in (self.task_tree, self.compact_task_tree):
            if tree.exists(item_id):
                tree.delete(item_id)

    def _update_task_row(self, task: DownloadTask) -> None:
        values = (
            task.status,
            task.request.save_format.upper(),
            self._shorten(task.request.url),
            self._shorten(task.detail, 60),
        )
        item_id = str(task.task_id)
        for tree in (self.task_tree, self.compact_task_tree):
            if tree.exists(item_id):
                tree.item(item_id, values=values)
            else:
                tree.insert("", "end", iid=item_id, values=values)

    def _paste_url(self) -> None:
        try:
            text = self.root.clipboard_get().strip()
        except tk.TclError:
            return
        self.url_var.set(text)

    def _remove_selected_task(self) -> None:
        selected = self.task_tree.selection()
        if not selected:
            return
        for item_id in selected:
            task = self.tasks.get(int(item_id))
            if not task or task.status in {STATUS_WAITING, STATUS_RUNNING, STATUS_CANCELLING}:
                continue
            self._delete_task_row(task.task_id)
            self.tasks.pop(task.task_id, None)
        self._refresh_status_summary("選択タスクを整理しました。")

    def _cancel_task_ids(self, task_ids: list[int]) -> int:
        cancelled_count = 0
        for task_id in task_ids:
            task = self.tasks.get(task_id)
            if not task or task.status not in {STATUS_WAITING, STATUS_RUNNING, STATUS_CANCELLING}:
                continue
            if task.cancel_event.is_set():
                continue
            task.cancel_event.set()
            self._set_task_state(task_id, STATUS_CANCELLING, "キャンセルしています。")
            cancelled_count += 1
        return cancelled_count

    def _cancel_selected_tasks(self) -> None:
        selected = [int(item_id) for item_id in self.task_tree.selection()]
        if not selected:
            return
        cancelled_count = self._cancel_task_ids(selected)
        if cancelled_count:
            self._append_log(f"{cancelled_count}件のキャンセルを受け付けました。")
            self._refresh_status_summary(f"{cancelled_count}件のキャンセルを受け付けました。")

    def _cancel_latest_active_task(self) -> None:
        active_ids = sorted(
            task.task_id
            for task in self.tasks.values()
            if task.status in {STATUS_WAITING, STATUS_RUNNING}
        )
        if not active_ids:
            return
        latest_task_id = active_ids[-1]
        cancelled_count = self._cancel_task_ids([latest_task_id])
        if cancelled_count:
            self._append_log(f"[{latest_task_id}] キャンセルを受け付けました。")
            self._refresh_status_summary(f"[{latest_task_id}] キャンセルを受け付けました。")

    def _clear_finished_tasks(self) -> None:
        finished_ids = [
            task.task_id
            for task in self.tasks.values()
            if task.status in {STATUS_DONE, STATUS_ERROR, STATUS_CANCELLED}
        ]
        for task_id in finished_ids:
            self._delete_task_row(task_id)
            self.tasks.pop(task_id, None)
        self._refresh_status_summary("完了済みタスクを消しました。")

    def _choose_output_dir(self) -> None:
        selected = filedialog.askdirectory(
            title="保存先フォルダを選択",
            initialdir=self.output_dir_var.get() or str(DEFAULT_OUTPUT_DIR),
        )
        if selected:
            self.output_dir_var.set(selected)

    def _open_output_dir(self) -> None:
        output_dir = Path(self.output_dir_var.get()).expanduser()
        output_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(["open", str(output_dir)], check=False)

    def _parse_urls(self) -> list[str]:
        raw_text = self.url_var.get().strip()
        if not raw_text:
            return []
        seen: set[str] = set()
        urls: list[str] = []
        for part in raw_text.split():
            url = part.strip()
            if url and url not in seen:
                seen.add(url)
                urls.append(url)
        return urls

    def _add_task_from_entry(self) -> None:
        urls = self._parse_urls()
        if not urls:
            messagebox.showerror("入力エラー", "URLを入力してください。")
            return

        available_slots = MAX_TASKS - self._active_task_count()
        if available_slots <= 0:
            messagebox.showerror(
                "上限です",
                f"同時に保持できるタスクは最大{MAX_TASKS}件です。完了待ちタスクが空くまで待ってください。",
            )
            return

        if len(urls) > available_slots:
            messagebox.showwarning(
                "件数を調整しました",
                f"追加できるのはあと{available_slots}件です。先頭から追加します。",
            )
            urls = urls[:available_slots]

        output_dir = Path(self.output_dir_var.get()).expanduser()
        requested_format = SaveFormat(self.format_var.get())
        for url in urls:
            detected_format = effective_save_format(url, requested_format)
            request = DownloadRequest(
                url=url,
                output_dir=output_dir,
                save_format=detected_format,
            )
            task = DownloadTask(task_id=self.next_task_id, request=request)
            self.next_task_id += 1
            self.tasks[task.task_id] = task
            self._update_task_row(task)
            site = detect_site(url)
            if detected_format != requested_format:
                self._append_log(
                    f"[{task.task_id}] キュー追加: {url} ({site.label} を検出したため MP3)"
                )
            else:
                self._append_log(f"[{task.task_id}] キュー追加: {url} ({site.label})")
            worker = threading.Thread(
                target=self._download_worker,
                args=(task.task_id,),
                daemon=True,
            )
            worker.start()

        self.url_var.set("")
        self._refresh_status_summary(f"{len(urls)}件のタスクを追加しました。")

    def _set_task_state(self, task_id: int, status: str, detail: str) -> None:
        task = self.tasks.get(task_id)
        if not task:
            return
        task.status = status
        task.detail = detail
        self._update_task_row(task)

    def _download_worker(self, task_id: int) -> None:
        task = self.tasks.get(task_id)
        if not task:
            return

        self._schedule_ui(
            self._set_task_state,
            task_id,
            STATUS_WAITING,
            f"待機中。最大{MAX_PARALLEL_DOWNLOADS}件まで同時保存します。",
        )

        acquired = False
        try:
            while not task.cancel_event.is_set():
                if self._download_slots.acquire(timeout=0.2):
                    acquired = True
                    break

            if task.cancel_event.is_set():
                self._schedule_ui(self._finish_cancelled, task_id, "キャンセルしました。")
                return

            self._schedule_ui(self._handle_task_started, task_id)

            def on_progress(message: str) -> None:
                self._schedule_ui(self._handle_task_progress, task_id, message)

            try:
                saved_path = download_media(
                    task.request,
                    progress_callback=on_progress,
                    should_cancel=task.cancel_event.is_set,
                    format_resolved_callback=lambda save_format: self._schedule_ui(
                        self._handle_task_format_resolved,
                        task_id,
                        save_format,
                    ),
                )
            except DownloadCancelled as error:
                self._schedule_ui(self._finish_cancelled, task_id, str(error))
                return
            except DownloadError as error:
                self._schedule_ui(self._finish_with_error, task_id, str(error))
                return
            except Exception as error:
                self._schedule_ui(
                    self._finish_with_error,
                    task_id,
                    f"想定外のエラー: {error}",
                )
                return

            self._schedule_ui(self._finish_successfully, task_id, saved_path)
        finally:
            if acquired:
                self._download_slots.release()

    def _handle_task_started(self, task_id: int) -> None:
        task = self.tasks.get(task_id)
        if not task or task.cancel_event.is_set():
            return
        self._set_task_state(task_id, STATUS_RUNNING, "保存を準備しています。")
        self._append_log(f"[{task_id}] 保存を開始しました。")
        self._refresh_status_summary(f"[{task_id}] 実行を開始しました。")

    def _handle_task_progress(self, task_id: int, message: str) -> None:
        task = self.tasks.get(task_id)
        if not task:
            return
        if task.cancel_event.is_set():
            self._set_task_state(task_id, STATUS_CANCELLING, "キャンセルしています。")
            self._refresh_status_summary(f"[{task_id}] キャンセルしています。")
            return
        self._set_task_state(task_id, STATUS_RUNNING, message)
        self._refresh_status_summary(f"[{task_id}] {message}")

    def _handle_task_format_resolved(self, task_id: int, save_format: SaveFormat) -> None:
        task = self.tasks.get(task_id)
        if not task or task.request.save_format == save_format:
            return
        task.request.save_format = save_format
        self._update_task_row(task)

    def _finish_successfully(self, task_id: int, saved_path: Path) -> None:
        self._set_task_state(task_id, STATUS_DONE, saved_path.name)
        self._append_log(f"[{task_id}] 保存完了: {saved_path}")
        self._refresh_status_summary(f"[{task_id}] 保存完了")

    def _finish_cancelled(self, task_id: int, message: str) -> None:
        self._set_task_state(task_id, STATUS_CANCELLED, message)
        self._append_log(f"[{task_id}] {message}")
        self._refresh_status_summary(f"[{task_id}] キャンセルしました。")

    def _finish_with_error(self, task_id: int, message: str) -> None:
        self._set_task_state(task_id, STATUS_ERROR, message)
        self._append_log(f"[{task_id}] エラー: {message}")
        self._refresh_status_summary(f"[{task_id}] 保存失敗")


def run_app() -> None:
    root = tk.Tk()
    app = UrlSaverApp(root)
    root.mainloop()
