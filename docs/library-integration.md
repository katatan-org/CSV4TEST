# ライブラリとしての組み込み（KATATAN連携）

CSV4TEST を、ほかのWebアプリの画面の中に、ライブラリとして組み込むための仕様。
最初の組み込み先は KATATAN（Svelte製）で、CSV4TEST は React のコンポーネントとして KATATAN の画面内に載る。

- 単体のアプリ（ローカルのフォルダを開いて編集する使い方）は、このまま残す。単体のアプリも、同じライブラリの上に組み立て直す。
- ファイルをどこから読み、どこへ保存するか（ローカルのフォルダ、KATATANのDB、Gitリポジトリ）は、`StorageBackend` として外から渡す。

## 要件定義（2026-10-02版）からの変更点

当初の要件定義「KATATAN CSV4TEST連携 要件定義」は、CSV4TESTを**別のアプリ**として、KATATANと同じオリジンの `/csv4test/` で配信し、セッションCookieで認証する前提だった。
KATATANの表エディタも CSV4TEST に統一すると決めたため、**KATATANの画面の中に組み込む**方式に変更する。

| 要件定義の項目 | 変更後 |
| --- | --- |
| R-D1、R-D2（`/csv4test/` での配信、バージョンの固定） | 配信は不要になる。KATATANは `@katatan/csv4test` パッケージのバージョンを `package.json` で固定する |
| R-A1〜R-A4（Cookieでの認証、401、ログインURL） | 不要になる。認証はKATATAN側の backend（既存のBearer認証）が行う。CSV4TESTは認証について何も知らない |
| R-C1（CSRF）、R-S1（CSP） | 不要になる（KATATANの既存の対策に含まれる） |
| 起動URL（`/csv4test/?repo=…`） | 不要になる。`mount()` の引数に置き換える |
| R-API1〜4 | KATATANの通常のAPIとして残す（パスはKATATANの規約に合わせる）。CSV4TESTから直接は呼ばず、KATATANの `GitSpecBackend` が呼ぶ。レスポンスの形式と、commitの処理要件は、要件定義のとおり |
| R-U1〜R-U4（起動の導線、新しいタブ、`return`） | KATATANの画面の中で開くので不要になる |
| R-N1〜R-N8 | KATATAN側のAPIの要件として、そのまま有効 |

**未決事項への回答**（KATATAN側の仕様は `KATATAN-TEST/docs/spec/feature/git-repository.md`）

| 項目 | 回答 |
| --- | --- |
| APIのパスの規約 | `/api/v4/workspaces/:wid/projects/:pid/repo/...`。リポジトリはプロジェクトに1つなので、`repoId` は使わない |
| CSRF | 不要（Bearer認証のため） |
| 内部リポジトリとリモートの同期 | KATATANは内部リポジトリを持たない。GitHubのAPIで直接commitし、ブランチの参照（ref）の更新が実質のpushになる。refの更新は、全部成功か全部失敗かのどちらかになる |
| 保護ブランチへのcommit | 保護ブランチでは `readOnly` で開く。作業ブランチを作るのはKATATANの画面側で行う。CSV4TEST側では、編集の途中でブランチが変わることはない |
| オブジェクトの形式 | SHA-1（GitHub） |
| Git LFS | 初期は対応しない。ツリーの項目に `lfs: true` が付いたファイルは、読み取り専用として扱う |
| 同じCSVの同時編集 | 初期は、ファイル単位で競合を判定する。行単位のマージは後続フェーズ |

## StorageBackend

定義は `src/storage/types.ts`。パスは backend のルートからの `/` 区切りの相対パスで表す。

```ts
export interface StorageBackend {
  readonly capabilities: BackendCapabilities;
  /** ルート配下の全ファイル（ディレクトリはパスから組み立てる）。tree が true のときに使う */
  listTree?(): Promise<TreeEntry[]>;
  /** ファイルがなければ NotFoundError で reject する */
  read(path: string): Promise<{ bytes: Uint8Array; version: string }>;
  save(changeSet: ChangeSet): Promise<SaveResult>;
  /** 画像の表示用URL（blob: か https:）。ファイルがなければ null */
  assetUrl?(path: string): Promise<string | null>;
  /** dir に baseName で始まる未使用の名前で画像を保存し、そのパスを返す */
  addAsset?(dir: string, baseName: string, file: Blob & { name?: string }): Promise<string>;
  /** `{{` の補完候補を追加する（Dictionary など） */
  variables?(): Promise<{ name: string; description?: string }[]>;
  /** 外部での変更を知らせる（git pull、push webhook など）。戻り値で購読を解除する */
  onExternalChange?(listener: (paths: string[]) => void): () => void;
  /** エディタがファイルを開いたとき・保存したときに呼ぶ。外部変更の監視対象にするため */
  watch?(path: string, version: string): void;
  /** タイマーや object URL を解放する */
  dispose?(): void;
}

export interface BackendCapabilities {
  tree: boolean;            // ファイルツリーを表示する
  images: boolean;          // 画像を追加できる（addAsset）
  commitMessage: boolean;   // 保存時にメッセージを入力させる（Git）
  autosave: boolean;        // 編集の2秒後に自動保存する（DB）。false なら Ctrl+S で保存する
  fixedColumns: boolean;    // 列の追加・削除・名前の変更・移動を禁止する（DB）
  readOnlyColumns: string[];// 編集を禁止する列の見出し（例: DBの No）
  readOnly: boolean;        // すべて読み取り専用
  download: boolean;        // 保存するとダウンロードになる（単体アプリのアップロード・サンプル）
}

export interface TreeEntry { path: string; version?: string; size?: number; lfs?: boolean }

export interface ChangeSet {
  files: { path: string; op: "put" | "delete"; bytes?: Uint8Array; baseVersion: string | null }[];
  /** 同じ変更を行単位で表したもの（行を保存する backend 向け。見出し行は含まない） */
  records?: {
    path: string;
    changes: RecordChange[]; // src/editor/changes.ts（record.id が編集中ずっと変わらない行のID）
    order: number[];         // データ行の id を今の並び順で並べたもの（移動の再現に使う）
    headers: string[];       // 今の列の並び
  };
  message?: string;          // commitMessage が true のとき
  force?: boolean;           // 競合のあとユーザーが「上書きして保存」を選んだとき
}

export type SaveResult =
  | { ok: true; versions: Record<string, string>; assigned?: Record<number, Record<string, string>>; message?: string }
  | { ok: false; conflict: { paths?: string[]; records?: { id: number; current?: Record<string, string> }[]; message?: string } }
  | { ok: false; error: { code: string; message: string; status?: number } };
```

- `version` の中身は backend ごとに違う（`FsAccessBackend` は `lastModified`、Git は blob SHA、DB は `updatedAt` など）。エディタは意味を解釈せず、`baseVersion` として返すだけ。`TreeEntry.version` は省略してよい（`read` が必ず返すため）。
- `save` が `conflict` を返すと、エディタは「保存できませんでした」のバナーを出し、「最新を読み込む（変更を破棄）」か「上書きして保存」を選ばせる。上書きを選ぶと `force: true` で `save` を呼び直す。
- `assigned` は、backend が保存時に値を決めた列を返すためのもの（例: DBが新しい行に採番した No）。キーは行の id と列の見出し。エディタはこの値を、未保存の変更にならない形で反映する。
- 保存中に続けて編集した内容は、保存済みにならない（保存を始めた時点のスナップショットだけを保存済みとして扱う）。自動保存で入力が途切れないようにするため。
- `addAsset` の保存のタイミング（すぐ書き込む、すぐアップロードする、次のcommitに含める）は backend が決める。

### 実装

| 実装 | 置き場所 | 用途 |
| --- | --- | --- |
| `FsAccessBackend` | CSV4TEST `src/storage/fsAccess.ts` | 単体アプリでフォルダを開く（File System Access API）。外部変更は2秒ごとに更新時刻を確認する |
| `FsFileBackend` | 同上 | 単体アプリでファイルを1つ開く（画像と `.csvview.json` は使えない） |
| `MemoryBackend` | CSV4TEST `src/storage/memory.ts` | サンプル、アップロードしたファイル（保存はダウンロード）、テスト |
| `DbSpecBackend` | KATATAN `frontend` | KATATANのDB管理モード（katatan-org/katatan-TEST#432） |
| `GitSpecBackend` | KATATAN `frontend` | KATATANのGit管理モード（katatan-org/katatan-TEST#434） |

## mount API

```ts
import { mount, type StorageBackend } from "@katatan/csv4test";

const editor = mount(container, {
  backend,                         // StorageBackend
  file: "tests/login.csv",         // 省略すると、tree が true ならツリーだけ表示する
  rootName: "login-tests",         // ツリーの見出し（省略時「ファイル」）
  readOnly: false,
  theme: "light",                  // "light" | "dark"
  themeVars: { "--accent": "#0f766e", "--font": "..." },
  onDirtyChange(dirty) {},
  onFileChange(path) {},
  onSaved(result) {},
  onError(error) {},
});

editor.isDirty();
await editor.save();               // 保存されなかったら false（キャンセル、競合、エラー）
await editor.open("tests/other.csv");
editor.currentPath();
editor.update({ theme: "dark" });  // あとから設定を変える（backend を渡し直すと読み込み直す）
editor.unmount();
```

`container` には高さを指定しておくこと（エディタはその高さいっぱいに広がる）。CSSは初回の `mount` で `<style id="csv4test-styles">` として自動で差し込まれるので、組み込み先でCSSファイルを読み込む必要はない。

## 組み込み時の制約

- **キーボードショートカット**: エディタの中にフォーカスがあるときだけ効く（`window` には登録しない）。Ctrl+S、Ctrl+F、Ctrl+Z、F1、? も同じ。
- **CSS**: すべてのルールを `.c4t` の配下に限定している。組み込み先のページのスタイルは変えない。`html`、`body` のルールは単体アプリ用の `app.css` に分けており、ライブラリには含まれない。
- **ページ全体の状態**: `document.title` と `beforeunload` は触らない。未保存の確認は、`isDirty()` と `onDirtyChange` を使って組み込み先が行う。`localStorage` のキーは `csv4test:` で始まるものだけを使う（列の幅、サイドパネルの開閉）。
- **セルのエディタ**: Glide Data Grid はセルを編集するときのエディタを `#portal` に描画する。なければエディタが `body` の末尾に作り、`.c4t` のスタイルとテーマを付ける。
- **テーマ**: `theme` でライト／ダークを切り替える。`themeVars` で CSS 変数（`--bg`、`--text`、`--accent`、`--border`、`--font` など。一覧は `src/styles.css` の先頭）を上書きできる。グリッドは Canvas で描画するため、CSS 変数のうち `--accent` と `--font` だけをグリッドにも反映する。
- **単体アプリ専用のUI**: 「フォルダを開く」「ファイル」、ようこそ画面、ウィンドウへのドラッグ＆ドロップ、テーマの切り替えボタン、Ctrl+O は単体アプリ（`src/App.tsx`）にだけある。
- **未対応**: UIの文言の差し替え（`messages`）はまだできない（文言は日本語のみ）。同じページに2つのエディタを置くと、`#portal` のテーマは最後に描画したエディタのものになる。

## パッケージ

- 名前は `@katatan/csv4test`。`npm run build:lib` で `dist-lib/` に出力する（Vite のライブラリモード、ESM、型定義付き）。
  - `@katatan/csv4test`: `mount` と backend（`MemoryBackend` など）、型
  - `@katatan/csv4test/core`: パーサー、シリアライザー、ドキュメントモデル、変更の計算、表示ルール。React も DOM も使わないので、サーバーからも使える（KATATAN がレポート用に CSV を取り込むときなど）
- React、ReactDOM、Glide Data Grid は同梱している。組み込み先は React に依存しない。
- サイズ（gzip）: 本体のチャンクが約220kB。Shift_JIS で保存するときにだけ読み込む文字コード表が約85kB。組み込み先では、エディタを開く画面で動的に `import()` すること。
- **配布方法**: GitHub リポジトリから直接インストールする（`@katatan/ui` と同じ方式）。npm には公開しない。
  - 組み込み先の `package.json` に、タグでバージョンを固定して書く: `"@katatan/csv4test": "github:katatan-org/CSV4TEST#v0.2.0"`
  - インストール時に `prepare`（`npm run build:lib`）が `dist-lib/` をビルドする。`dist-lib/` は Git に含めない。
  - React、Glide Data Grid などはライブラリに同梱しているので、`devDependencies` に置いている。組み込み先の `node_modules` には `@katatan/csv4test` だけが入る。
  - private リポジトリなので、組み込み先の CI ではこのリポジトリを読めるトークンが必要（KATATAN の CI は `GH_PAT` で `@katatan/ui` を取得しているのと同じ仕組みを使う）。
  - npm 11 では、インストール時に「`prepare` が `allowScripts` で許可されていない」という警告が出る。`allowScripts` に許可を書いても警告は消えないが、ビルドは実行される（npm 11.19 で確認）。将来の npm がこのビルドを止めるようになった場合は、ビルド済みの成果物を GitHub のリリースに添付して、その URL から取り込む方式に切り替える。
- **リリースの手順**: `main` にマージしたら `vX.Y.Z` のタグを付ける。組み込み先は、そのタグに書き換えて `npm install` する。

## 開発

- `embed.html`（開発サーバー専用）は、React を使わないページから `mount()` で組み込むテスト用のホスト。`npm run dev` で `http://localhost:5173/embed.html` を開き、コンソールで `__embed.mount({ "a.csv": "No,Test Subject\n1,x\n" }, { tree: true })` のように試せる。
- E2E テスト `e2e/embed.spec.ts` が、組み込み時の動作（backend 経由の保存、ショートカットの範囲、組み込み先のスタイル、読み取り専用の列、自動保存、コミットメッセージ、競合）を確認する。

## 検証

- 単体アプリが、ライブラリの上に組み直した後も、今のE2Eテスト（`npm run e2e`）と単体テストをすべて通ること。
- `MemoryBackend` を使って、`mount` → 編集 → `save` を行い、`ChangeSet` の `files[].bytes` が今のロスレス書き出しと一致し、`records` に行の変更と並び順が正しく入っていること。
- 組み込み先のページのスタイルが、`mount` の前後で変わらないこと。
