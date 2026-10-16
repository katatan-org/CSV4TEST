# CSV4TEST

Git で管理するテストケース CSV を、読みやすく表示・編集するための Web アプリです。
CSV を開くと列ごとのルールで自動的に整形して表示し、Excel のように編集できます。

- **見た目の情報は CSV に書き込みません。** 列幅・色・手順の番号付けは表示のときだけ付きます。
- **保存しても差分は最小です。** 編集していない行は元のバイト列のまま書き戻します。改行コード（CRLF / LF、セル内改行も含む）、BOM、クォートの付け方、末尾改行の有無、文字コード（UTF-8 / Shift_JIS）を保持します。
- **並べ替え・絞り込みは表示だけ**に効きます。ファイルの行順が変わるのは、行をドラッグで移動したときだけです。

## 使い方

Node.js 22 以上が必要です（推奨は 24 LTS。`.nvmrc` に記載しています）。

```bash
nvm use            # .nvmrc の Node 24 に切り替え
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/ に静的ファイルを出力（サーバー不要。任意の静的ホスティングに置けます）
```

| 操作 | 方法 |
|---|---|
| リポジトリを開く | 「フォルダを開く」（Chrome / Edge）。CSV をツリーで選び、Ctrl+S でその場に保存します |
| ファイルだけ開く | 「ファイル」、またはドラッグ＆ドロップ。File System Access API に対応していないブラウザでは、保存はダウンロードになります |
| 編集 | セルを選んで入力するか、Enter / F2。Alt+Enter でセル内改行、`{{` で変数を補完 |
| Excel とのやり取り | Ctrl+C / Ctrl+V。セル内改行も保ったまま貼り付けられます |
| 行 / 列 | 行番号・列見出しにマウスを乗せると罫線上に出る ＋ ボタン、右クリックメニュー、列見出しのメニュー、Ctrl+Shift++（行の挿入）、Ctrl+-（行の削除） |
| 行の追加 | 最終行より下の空白セルにそのまま入力できます。間の空白行は空の行（区切り文字だけ）として保存します |
| 変更の確認 | サイドパネルの「変更」タブで、保存前にセル単位の差分を見られます |
| ヘルプ | F1（またはツールバーの ? ）で挙動の説明、? キー（またはキーボードのアイコン）でショートカット一覧 |
| 表示言語 | 日本語と英語。初めはブラウザの言語に合わせ、ツールバーの「English」/「日本語」で切り替えます（次回も同じ言語で開きます） |

アプリを開いている間に `git pull` や `git checkout` でファイルが変わると、自動で再読み込みします（未保存の変更がある場合は確認します）。

## KATATAN 形式

ヘッダーに `No, Test Subject, Preconditions, Steps, Expected Result, Notes` があれば、KATATAN 形式と判定します。

| 列 | 表示 |
|---|---|
| No | `case-N` として表示し、左に固定します（データは数値のまま） |
| Labels（省略可） | セル内の **1行に1ラベル** を書きます。バッジで表示し、ラベルで絞り込めます |
| Steps | 1行を1手順として、番号を付けて表示します（番号はデータに書き込みません） |
| Preconditions など | `case-N` をクリックすると、そのケースへジャンプします |
| Images（省略可） | CSV からの **相対パスを1行に1つ** 書きます。「画像を追加」、ドラッグ＆ドロップ、スクリーンショットの貼り付けで `<CSV名>.assets/case-N-連番.png` に保存し、パスを追記します |

`{{変数}}`、`'入力値'`、`{パラメーター}` は色付きで強調します。
サイドパネルの「検証」タブでは、No の重複、存在しない `case-N` への参照、閉じていない `{{`、見つからない画像、どの行からも参照されていない画像を警告します。

## 表示ルールのカスタマイズ（`.csvview.json`）

CSV と同じフォルダ、またはその上位フォルダに `.csvview.json` を置くと、組み込みルールを上書きできます。CSV に最も近いファイルが使われます。

```json
{
  "extends": "katatan",
  "columns": [
    { "match": "Steps", "width": 520 },
    { "match": "Priority", "badge": { "High": "red", "Medium": "amber", "Low": "gray" } },
    { "match": "/^備考/", "color": "muted", "wrap": true }
  ],
  "rows": [{ "when": { "column": "Priority", "equals": "High" }, "background": "red-soft" }],
  "labelColors": { "Smoke": "teal" }
}
```

- `match`：列名（大文字・小文字と空白の違いは無視します）、または `/正規表現/`
- 列の指定：`width`, `pinned`, `wrap`, `bold`, `font` (`mono`), `align`, `color`, `background`, `display` (`text` / `steps` / `labels` / `images` / `id`), `format`（例 `"case-{value}"`）, `placeholder`, `tokens`, `badge`（値と色の対応、または `"auto"`）
- 色：`green` `red` `amber` `blue` `purple` `teal` `pink` `orange` `gray`、その薄い背景色 `<色>-soft`、控えめな文字色 `muted`
- `extends`：`katatan` または `generic`（省略するとヘッダーから自動判定します）

KATATAN 以外の CSV は汎用ルールで表示します。数値は右寄せ、日付は等幅、種類の少ない値はバッジ、長い文章は折り返して表示します。

## 開発

```bash
npm test           # 単体テスト（ロスレスな往復変換、git diff で1行だけ変わることの確認を含む）
npm run e2e        # Chrome での E2E テスト（OPFS 上のフォルダで開く → 編集 → 保存まで、ライブラリとしての組み込み、日本語と英語の表示）
npm run typecheck
npm run build:lib  # ライブラリ @katatan/csv4test を dist-lib/ に出力（docs/library-integration.md）
```

主なファイル：

- `src/csv/` — ロスレスな CSV パーサーとシリアライザー、ドキュメントモデル（イミュータブル）、文字コード処理
- `src/rules/` — ルールのスキーマ、プリセット（`katatan` / `generic`）、自動判定、トークン分割、検証
- `src/editor/` — Undo / Redo、クリップボード（TSV）、検索と置換、変更の計算、表示行の計算
- `src/ui/` — Glide Data Grid のカスタムセル（Canvas 描画）とエディター、パネル類
- `src/fs/` — File System Access API の低レベルな関数、画像の読み込み
- `src/storage/` — ファイルの読み書きの抽象（`StorageBackend`）と、フォルダ・単一ファイル・メモリ上の実装
- `src/i18n/` — UI の文言のカタログ（`ja.ts` が元、`en.ts`）と、言語ごとのヘルプ（`help.*.tsx`）
- `src/Editor.tsx` — 編集画面（backend を受け取る。単体アプリとライブラリで共通）
- `src/App.tsx` — 単体アプリの外枠（フォルダやファイルを開く、ようこそ画面、ドラッグ＆ドロップ）
- `src/lib/` — ライブラリの入口（`mount`、`core`）

## ライセンス

[MIT](LICENSE)
