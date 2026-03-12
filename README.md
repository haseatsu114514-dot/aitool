# AI Workboard

Mac 上で今どの AI が動いていて、何の作業をしていそうかを一画面で見るためのローカル試作です。

## できること

- `Codex` の最新スレッド名と対象フォルダを表示
- `Claude` の最新セッション名を表示
- `Antigravity` のワークスペースや開いているファイル候補を表示
- `Chrome / Arc / Safari` 上の AI タブを一覧表示
- `Genspark / Gemspark` のタブも検出
- `今作業中 / 待機中 / ブラウザ` を見やすく整理
- 過去の所要時間から、ざっくりした終了予想を出す
- 使っていない AI を自分で隠して、あとで戻せる

## 使い方

### ブラウザで使う

```bash
cd "/Users/hasegawaatsuki/Documents/New project/ai-workboard"
npm start
```

起動したら、ブラウザで次を開きます。

```text
http://localhost:4315
```

### Mac アプリとして使う

開発中の形でそのまま開く場合:

```bash
cd "/Users/hasegawaatsuki/Documents/New project/ai-workboard"
npm run desktop
```

Dock に置ける `.app` を作る場合:

```bash
cd "/Users/hasegawaatsuki/Documents/New project/ai-workboard"
npm run desktop:build
open "dist/AI Workboard-darwin-arm64/AI Workboard.app"
```

生成された `AI Workboard.app` は `dist/AI Workboard-darwin-arm64` にできます。  
`Applications` に移してから Dock に追加すると、ブラウザと分けて使えます。

## メモ

- すべてローカルで動きます。
- 一部のアプリは内部状態を直接読めないため、状態や終了予想は推定です。
- 履歴は `data/session-store.json` に保存します。

## 他アプリ管理

このリポジトリを、デスクトップにある自作アプリの管理ハブとしても使うようにしています。

```bash
cd "/Users/hasegawaatsuki/Documents/New project/ai-workboard"
python3 desktop_apps/manage.py list
```

詳細は `desktop_apps/README.md` を参照してください。
