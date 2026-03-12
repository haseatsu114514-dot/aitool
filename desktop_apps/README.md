# Desktop Apps Hub

このリポジトリを、デスクトップに置いている自作アプリの管理ハブとして使うための入口です。

今の方針:

- `ai-workboard` を親リポジトリとして使う
- nested git ではないアプリは `apps/` 配下へ寄せる
- デスクトップ上の `.app` とソースの対応表を `apps.json` で管理する
- `manage.py` から一覧確認、詳細確認、build/run を呼べるようにする

## 対象アプリ

| App ID | デスクトップ上の名前 | ソース |
| --- | --- | --- |
| `ai-workboard` | `AI管理ツール.app` | `./` |
| `clipboard-menu` | `Clipboard Menu.app` | `apps/clipboard-menu-mac/` |
| `media-url-saver` | `Media URL Saver.app` | `apps/youtube-url-saver/` |
| `voice-input` | `Voice Input.app` | `../voice/` |

## 使い方

一覧を確認:

```bash
cd "/Users/hasegawaatsuki/Documents/New project/ai-workboard"
python3 desktop_apps/manage.py list
```

1つのアプリの詳細を見る:

```bash
python3 desktop_apps/manage.py info voice-input
```

ビルドコマンドだけ確認したいとき:

```bash
python3 desktop_apps/manage.py build media-url-saver --dry-run
```

実際にビルド/更新するとき:

```bash
python3 desktop_apps/manage.py build clipboard-menu
python3 desktop_apps/manage.py build voice-input
```

デスクトップ上のアプリをそのまま開く:

```bash
python3 desktop_apps/manage.py open-desktop ai-workboard
```

## メモ

- `Kindle Screenshot` は今回の push 対象から外しています。
- `voice-input` はまだ `../voice` の別リポジトリです。
- `Git` 列が `nested-git` のものは、そのフォルダ自体に別 `.git` がある状態です。`external-git` は ai-workboard リポジトリ外の別 repo を参照しています。
- このハブは「今どのデスクトップアプリをどこで管理するか」を明確にするためのものです。必要なら次の段階で、`voice` もこの repo へ吸収できます。
