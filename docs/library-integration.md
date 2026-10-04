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

```ts
export interface StorageBackend {
  readonly capabilities: {
    /** ファイルツリーを表示する（複数のファイルを扱う） */
    tree: boolean;
    /** 画像を追加できる */
    images: boolean;
    /** 保存時にメッセージを入力させる（Git） */
    commitMessage: boolean;
    /** 自動保存する（DB）。false なら Ctrl+S で明示的に保存する */
    autosave: boolean;
    /** 列の追加、削除、名前の変更を禁止する（DB） */
    fixedColumns: boolean;
    /** 指定した列を読み取り専用にする（例: DBの No） */
    readOnlyColumns?: string[];
    readOnly: boolean;
  };

  listTree?(): Promise<TreeEntry[]>;
  read(path: string): Promise<{ bytes: Uint8Array; version: string }>;
  save(changeSet: ChangeSet): Promise<SaveResult>;
  /** 画像のパスから、表示用のURLを返す（blob: か https:） */
  assetUrl(path: string): Promise<string | null>;
  /** 画像を受け取り、保存先のパスを返す（Images列に追記するパス） */
  addAsset?(csvPath: string, file: Blob, hint: { caseNo: string }): Promise<string>;
  /** `{{` の補完候補 */
  variables?(): Promise<{ key: string; description?: string }[]>;
  /** 外部で変更があったことを知らせる（git pull、push webhook など） */
  onExternalChange?(cb: (paths: string[]) => void): () => void;
}

export interface TreeEntry { path: string; version: string; size: number; lfs?: boolean }

export interface ChangeSet {
  message?: string;                       // commitMessage が true のとき
  files: {
    path: string;
    op: "put" | "delete";
    bytes?: Uint8Array;                   // put のとき。ロスレスに書き出したバイト列
    baseVersion: string | null;           // 読み込んだときの version（新しいファイルなら null）
  }[];
  /** CSV1ファイル分の、行単位の変更（DBのbackendが使う） */
  records?: {
    path: string;
    changes: RecordChange[];              // src/editor/changes.ts の型に、行の id を加えたもの
    order: number[];                      // 今の並び順での、行の id の配列（並べ替えを伝えるため）
  };
}

export type SaveResult =
  | { ok: true; versions: Record<string, string>; recordIds?: Record<number, string> }
  | { ok: false; conflict: { paths?: string[]; records?: { id: number; current: Record<string, string> }[] } }
  | { ok: false; error: { code: string; message: string; status?: number } };
```

- `version` の中身は、backendによって違う。`FsAccessBackend` では `lastModified`、`GitSpecBackend` では blob SHA、`DbSpecBackend` では `updatedAt` を元にした値を入れる。CSV4TEST側は、この値の意味を解釈しない。
- `save` で `conflict` が返ってきたら、競合したファイルや行を差分の表示で示し、ユーザーに「再読み込み」か「上書き」かを選ばせる。
  - 上書きを選んだときは、新しい `baseVersion` で `save` を呼び直す。
- `recordIds` は、DBのbackendが新しく作った行に割り当てたID（No）を返すためのもの。CSV4TESTは、受け取ったIDを No 列に反映する。

### 用意する実装

| 実装 | 置き場所 | 用途 |
| --- | --- | --- |
| `FsAccessBackend` | CSV4TEST `src/fs/` | 単体アプリ（File System Access API。今の `fileAccess.ts` と `imageStore.ts` を移す） |
| `MemoryBackend` | CSV4TEST `src/fs/` | テスト用と、サンプルの表示用 |
| `DbSpecBackend` | KATATAN `frontend` | KATATANのDB管理モード |
| `GitSpecBackend` | KATATAN `frontend` | KATATANのGit管理モード（R-API1〜4） |

## mount API

```ts
import { mount } from "@katatan/csv4test";

const editor = mount(container, {
  backend,
  file: "tests/login.csv",        // 省略時、tree が true ならツリーだけ表示する
  readOnly: false,
  theme: { /* CSS変数の上書き */ },
  locale: "ja",
  messages: { /* 文言の上書き */ },
  onDirtyChange(dirty) {},
  onSaved(result) {},
  onError(error) {},
});

editor.isDirty();
await editor.save();
editor.unmount();
```

## 組み込み時の制約

- **キーボードショートカット**: `container` の中にフォーカスがあるときだけ効く。`window` には登録しない。F1、?、Ctrl+S、Ctrl+F も同じ。
- **グローバルな状態**: `document.title`、`body` のスタイル、`localStorage` のキーを書き換えない。`localStorage` を使う場合は、キーの先頭に `csv4test:` を付ける。
- **テーマ**: `src/ui/theme.ts` の色を、CSS変数（`--c4t-*`）から読むようにする。組み込み先は、自分のデザイントークンを `theme` で渡す。Canvasの描画も、このCSS変数の値を使う。
- **文言**: UIの文字列は、`messages` で上書きできるようにする。既定は今の日本語。
- **単体アプリ専用のUI**: 「フォルダを開く」「ファイル」「ダウンロード」、ドラッグ＆ドロップでファイルを開く機能は、`capabilities` と `tree` の設定に応じて隠す。
- **ヘッダーの領域**: 組み込み先が自分のヘッダー（ブランチ、PR、保存状態など）を持つので、CSV4TESTのツールバーは、編集の操作に限る。

## パッケージ

- 名前は `@katatan/csv4test` とし、Viteのライブラリモードで ESM として出力する。
- React、ReactDOM、Glide Data Grid は**同梱する**。組み込み先は React に依存しない。
- 型定義（`d.ts`）を出力する。
- 中核部分（`src/csv`、`src/rules`）は、`@katatan/csv4test/core` として、Reactを含まない形でも公開する。KATATANのサーバーがレポートを取り込むときに、CSV4TESTと同じパーサーを使うため。
- KATATANのテストレポート用のプリセット `katatan-report` を追加する（結果の列 `Result, Tester, Executed At, Result Notes, Evidence` を、バッジと日時で表示する）。

## 検証

- 単体アプリが、ライブラリの上に組み直した後も、今のE2Eテスト（`npm run e2e`）と単体テストをすべて通ること。
- `MemoryBackend` を使って、`mount` → 編集 → `save` を行い、`ChangeSet` の `files[].bytes` が今のロスレス書き出しと一致し、`records` に行の追加・削除・変更・並び順が正しく入っていること。
- 2つのエディタを同じページに `mount` しても、ショートカットとスタイルが互いに干渉しないこと。
