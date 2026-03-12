# Media URL Saver

入力したURL先をそのまま `MP3` または `MP4` として保存するローカル用アプリです。`yt-dlp` が対応しているサイトであれば、YouTube 以外の幅広いURLも扱えます。

- `MP3`: `320kbps` で保存
- `MP4`: `1080p` を上限に保存
- `最大10件` のタスクを保持
- `2件並行` で保存、残りは待機
- URLからサイトを自動判別し、未登録サイトもドメイン表示で扱う
- `SoundCloud` など動画のないURLは自動で `MP3` 扱い
- 待機中 / 実行中タスクのキャンセルに対応
- GUI と CLI の両方に対応

## 使い方

### 1. GUIで使う

`start_app.command` をダブルクリックすると起動します。

初回は仮想環境の作成とライブラリのインストールが入るので、少し時間がかかります。

URLを1件ずつ追加すると、タスク一覧に入り、自動で保存を開始します。
同時に保存するのは最大2件で、残りは待機します。
起動時は `コンパクト` 表示です。URL、保存先、形式、変換ボタン中心の小さい画面で使えます。
右上の `詳細` を押すと通常表示へ切り替わります。
URLを入れるとサイトを自動判定し、既知サイト以外もドメイン名ベースで表示します。動画のないURLは `MP3` に自動で寄せます。
保存先の初期値は `デスクトップ/YYYY-MM-DD` 形式の当日日付フォルダで、起動時に自動作成します。

### 2. ターミナルで使う

```bash
cd "/Users/hasegawaatsuki/Documents/New project/ai-workboard/apps/youtube-url-saver"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

URLを直接渡すとCLIで保存できます。

```bash
python main.py "https://www.youtube.com/watch?v=VIDEO_ID" --format mp3
python main.py "https://www.youtube.com/watch?v=VIDEO_ID" --format mp4
```

保存先を変える場合:

```bash
python main.py "https://www.youtube.com/watch?v=VIDEO_ID" --format mp4 --output-dir ~/Downloads
```

複数URLをまとめて渡す場合:

```bash
python main.py "https://www.youtube.com/watch?v=AAA" "https://www.youtube.com/watch?v=BBB" --format mp3
python main.py "https://www.youtube.com/watch?v=AAA" "https://www.youtube.com/watch?v=BBB" --format mp4 --jobs 2
```

## 補足

- `MP3` は取得できた元音声をもとに `320kbps` へ変換します。
- `yt-dlp` が対応しているサイトであれば、動画サイト、音声サイト、投稿ページURLなど幅広く保存できます。
- アプリ上のサイト表示は URL のドメインをもとに自動判定します。未対応サイトだった場合は保存時にエラーになります。
- `SoundCloud` のように動画がなく音声だけあるURLは、`MP4` を選んでいても自動で `MP3` に切り替えます。
- `MP4` は `1080p` を超える解像度は取得しません。
- GUI と CLI ともに、一度に保持するタスクは最大10件です。
- 利用権限のある動画のみ保存してください。
