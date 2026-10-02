import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";

function Modal({ title, onClose, children, wide, className }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={["modal", wide && "wide", className].filter(Boolean).join(" ")} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="閉じる">
            <Icon name="x" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export interface PromptRequest {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  resolve: (value: string | null) => void;
}

export function PromptDialog({ request, onDone }: { request: PromptRequest; onDone: () => void }) {
  const [value, setValue] = useState(request.initial ?? "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (v: string | null) => {
    request.resolve(v);
    onDone();
  };
  return (
    <Modal title={request.title} onClose={() => finish(null)}>
      <form
        className="prompt"
        onSubmit={(e) => {
          e.preventDefault();
          finish(value);
        }}
      >
        <label>
          {request.label}
          <input ref={input} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <footer>
          <button type="button" onClick={() => finish(null)}>
            キャンセル
          </button>
          <button type="submit" className="primary">
            {request.confirmLabel ?? "OK"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl+S", "保存"],
  ["Ctrl+Z / Ctrl+Y", "元に戻す / やり直す"],
  ["Ctrl+F / Ctrl+H", "検索 / 置換"],
  ["Enter / F2 / 入力開始", "セルを編集"],
  ["Alt+Enter（編集中）", "セル内で改行"],
  ["Enter / Tab（編集中）", "確定して下 / 右へ"],
  ["Esc（編集中）", "編集を取り消す"],
  ["{{（編集中）", "変数名を補完"],
  ["Ctrl+C / Ctrl+X / Ctrl+V", "コピー / 切り取り / 貼り付け（Excelと相互にやり取りできます）"],
  ["Delete", "選択範囲をクリア"],
  ["Ctrl+D / Ctrl+R", "下方向 / 右方向にコピー"],
  ["フィルハンドル", "選択範囲の右下をドラッグして複写"],
  ["Ctrl+Shift+＋", "下に行を挿入"],
  ["Ctrl+−", "選択行を削除"],
  ["Shift+クリック / Ctrl+クリック", "範囲選択 / 複数選択"],
  ["行番号・列見出しの ＋", "行・列を挿入"],
  ["行番号をドラッグ", "行を移動（並べ替え・絞り込み中は不可）"],
  ["列見出しをドラッグ", "列を移動"],
  ["case-N をクリック", "そのケースへジャンプ"],
  ["?", "このショートカット一覧"],
  ["F1", "ヘルプ（挙動の説明）"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="キーボードショートカット" onClose={onClose} wide>
      <dl className="shortcuts">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="note">
        見た目（列幅・色・番号付け）はCSVに書き込まれません。保存時は編集した行だけが書き換わり、改行コード・BOM・クォートは元のまま保たれます。
      </p>
    </Modal>
  );
}

export interface LightboxImage {
  path: string;
  url?: string;
  status: string;
}

export function Lightbox({ images, index, onIndex, onClose }: { images: LightboxImage[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const img = images[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && index < images.length - 1) onIndex(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, images.length, onIndex, onClose]);
  if (!img) return null;
  return (
    <div className="lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lightbox-bar">
        <span className="mono">{img.path}</span>
        <span>
          {index + 1} / {images.length}
        </span>
        {img.url && (
          <a className="icon-button" href={img.url} target="_blank" rel="noreferrer" aria-label="新しいタブで開く">
            <Icon name="external" />
          </a>
        )}
        <button className="icon-button" onClick={onClose} aria-label="閉じる">
          <Icon name="x" />
        </button>
      </div>
      {img.url ? <img src={img.url} alt={img.path} /> : <p className="lightbox-missing">画像を読み込めません（{img.status}）</p>}
      {index > 0 && (
        <button className="lightbox-nav prev" onClick={() => onIndex(index - 1)} aria-label="前の画像">
          <Icon name="chevronLeft" size={28} />
        </button>
      )}
      {index < images.length - 1 && (
        <button className="lightbox-nav next" onClick={() => onIndex(index + 1)} aria-label="次の画像">
          <Icon name="chevronRight" size={28} />
        </button>
      )}
    </div>
  );
}

interface GuideSection {
  id: string;
  title: string;
  body: ReactNode;
}

const GUIDE: GuideSection[] = [
  {
    id: "overview",
    title: "CSV4TEST とは",
    body: (
      <>
        <p>Git で管理するテストケース CSV を、読みやすく表示して Excel のように編集するためのツールです。</p>
        <ul>
          <li>
            <b>見た目は CSV に書き込みません。</b>列幅・色・バッジ・手順の番号は表示するときだけ付きます。
          </li>
          <li>
            <b>保存しても差分は最小です。</b>編集していない行は元のバイト列のまま書き戻すので、git diff には編集した行だけが出ます。
          </li>
          <li>
            <b>並べ替え・絞り込みは表示だけに効きます。</b>ファイルの行順は変わりません。
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "files",
    title: "開く・保存する",
    body: (
      <>
        <dl>
          <dt>フォルダを開く（Chrome / Edge）</dt>
          <dd>リポジトリのフォルダを開き、左のツリーから CSV を選びます。Ctrl+S でそのファイルに上書き保存します。画像の追加もこの方法で開いたときだけ使えます。</dd>
          <dt>ファイル / ドラッグ＆ドロップ</dt>
          <dd>CSV を1つだけ開きます。ブラウザが直接の書き込みに対応していない場合、保存はダウンロードになります。</dd>
          <dt>サンプル</dt>
          <dd>読み取り専用です。保存するとダウンロードになります。</dd>
        </dl>
        <p>
          開いている間に <code>git pull</code> や <code>git checkout</code> でファイルが変わると、自動で読み込み直します。未保存の変更があるときは確認します。
        </p>
        <p>文字コード（UTF-8 / Shift_JIS）、BOM、改行コード（CRLF / LF、セル内改行も含む）、クォートの付け方、末尾改行の有無は、読み込んだときのまま保存します。</p>
      </>
    ),
  },
  {
    id: "editing",
    title: "編集",
    body: (
      <>
        <dl>
          <dt>セルの編集</dt>
          <dd>セルを選んでそのまま入力するか、Enter / F2 で編集を始めます。Alt+Enter でセル内改行、Esc で取り消しです。</dd>
          <dt>行を増やす</dt>
          <dd>
            最終行の下にある空白のセルにそのまま入力できます。間に空いた行は、区切り文字だけの空の行（例 <code>,,,,</code>）として保存します。空白のセルを消しただけでは行は増えません。
          </dd>
          <dt>行・列の挿入</dt>
          <dd>
            行番号にマウスを乗せると上下の罫線に、列見出しに乗せると左右の罫線に <b>＋</b> ボタンが出ます。右クリックメニューや列見出しのメニューからも挿入・削除できます。
          </dd>
          <dt>行の選択と移動</dt>
          <dd>行番号をクリックすると行を選択します。ドラッグすると行を移動します（並べ替え・絞り込み中はできません）。列は見出しをドラッグして移動します。</dd>
          <dt>Excel とのやり取り</dt>
          <dd>Ctrl+C / Ctrl+V でセル範囲をコピー・貼り付けできます。セル内改行も保ちます。1つの値を範囲に貼ると、範囲全体を埋めます。</dd>
          <dt>元に戻す</dt>
          <dd>Ctrl+Z / Ctrl+Y で、どの操作も元に戻せます。</dd>
        </dl>
      </>
    ),
  },
  {
    id: "view",
    title: "並べ替え・絞り込み",
    body: (
      <>
        <p>どちらも表示だけに効き、ファイルの行順は変わりません。</p>
        <dl>
          <dt>並べ替え</dt>
          <dd>
            列見出しのメニューから選びます。並べ替えたときの順番をそのまま保つので、編集しても行が勝手に動くことはありません。並べ替えた後に追加した行は末尾に表示されます。
          </dd>
          <dt>絞り込み</dt>
          <dd>
            ツールバーの「行を絞り込み」はすべての列から探します。列見出しのメニューでは列ごとに、サイドパネルの「ラベル」「変数」タブではラベルや変数を使っている行だけに絞り込めます。
          </dd>
        </dl>
        <p>絞り込み中は、最終行の下の空白行を表示しません（入力した行が条件に合わず、すぐ見えなくなるのを防ぐためです）。</p>
      </>
    ),
  },
  {
    id: "rules",
    title: "表示ルールと自動判定",
    body: (
      <>
        <p>
          開いた CSV の見出しから、どの表示ルールを使うかを自動で判定します。見出しに <code>No, Test Subject, Preconditions, Steps, Expected Result, Notes</code>{" "}
          がそろっていれば <b>KATATAN 形式</b>、それ以外は <b>汎用 CSV</b> として表示します。サイドパネルの「表示ルール」タブで、使うルールを切り替えられます。
        </p>
        <h4>汎用 CSV の列の見た目</h4>
        <p>列ごとに先頭 300 行の値を調べて、見た目を決めます。</p>
        <table>
          <tbody>
            <tr>
              <th>9割以上が数値</th>
              <td>右寄せ・等幅</td>
            </tr>
            <tr>
              <th>9割以上が日付</th>
              <td>等幅</td>
            </tr>
            <tr>
              <th>9割以上が URL</th>
              <td>リンクとして強調・折り返し</td>
            </tr>
            <tr>
              <th>値の種類が少ない</th>
              <td>
                値ごとに色分けした<b>バッジ</b>（空でない値が4件以上、種類が8種類以下で同じ値が繰り返し出る、どれも24文字以内で改行なし）
              </td>
            </tr>
            <tr>
              <th>複数行・長い文章</th>
              <td>折り返し</td>
            </tr>
          </tbody>
        </table>
        <div className="guide-callout">
          <b>表示が急に変わったときは</b>
          <p>
            この判定は、編集のたびではなく<b>ファイルを開いたとき・見出しを変えたとき・列を追加／削除したとき</b>にやり直します。そのため、値を入力した後で列を追加すると、その時点のデータで判定し直して、列が急にバッジ表示になることがあります。CSV の中身は変わりません。
          </p>
          <p>
            見た目を固定したいときは、<code>.csvview.json</code> で列ごとにルールを指定します（「カスタマイズ」を参照）。
          </p>
        </div>
      </>
    ),
  },
  {
    id: "katatan",
    title: "KATATAN 形式",
    body: (
      <>
        <table>
          <tbody>
            <tr>
              <th>No</th>
              <td>
                <code>case-N</code> と表示し、左に固定します（データは数値のまま）。行を挿入すると次の番号を自動で振ります。
              </td>
            </tr>
            <tr>
              <th>Labels（省略可）</th>
              <td>セル内の1行に1ラベルを書きます。バッジで表示し、ラベルで絞り込めます。</td>
            </tr>
            <tr>
              <th>Steps</th>
              <td>1行を1手順として番号を付けて表示します（番号はデータに書き込みません）。</td>
            </tr>
            <tr>
              <th>Expected Result</th>
              <td>薄い緑の背景で表示します。</td>
            </tr>
            <tr>
              <th>Images（省略可）</th>
              <td>
                CSV からの相対パスを1行に1つ書きます。「画像を追加」、ドラッグ＆ドロップ、スクリーンショットの貼り付けで <code>&lt;CSV名&gt;.assets/</code> に保存し、パスを追記します。
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          <code>{"{{変数}}"}</code>、<code>{"'入力値'"}</code>、<code>{"{パラメーター}"}</code> は色付きで強調し、<code>case-N</code> はクリックするとそのケースへジャンプします。編集中に{" "}
          <code>{"{{"}</code> と打つと、使われている変数名を補完します。
        </p>
        <p>Labels 列・Images 列がないときは、ツールバーのボタンで追加できます。空のファイルを開いたときは、KATATAN 形式の見出しを作れます。</p>
      </>
    ),
  },
  {
    id: "panel",
    title: "サイドパネル",
    body: (
      <dl>
        <dt>検証</dt>
        <dd>No の重複、存在しない case-N への参照、閉じていない {"{{"}、見つからない画像、どの行からも参照されていない画像を警告します。クリックすると該当のセルへ移動します。</dd>
        <dt>変更</dt>
        <dd>保存していない変更を、行・セル単位で確認できます。</dd>
        <dt>変数</dt>
        <dd>使われている {"{{変数}}"} の一覧です。クリックすると、その変数を使う行だけを表示します。</dd>
        <dt>ラベル</dt>
        <dd>ラベルの一覧です。選んだラベルを持つ行だけを表示します（複数選ぶといずれかを持つ行）。</dd>
        <dt>表示ルール</dt>
        <dd>使っているルールと、列ごとの見た目を確認できます。</dd>
      </dl>
    ),
  },
  {
    id: "custom",
    title: "カスタマイズ",
    body: (
      <>
        <p>
          CSV と同じフォルダ（または上位のフォルダ）に <code>.csvview.json</code> を置くと、列ごとの幅・色・表示方法を上書きできます。CSV に最も近いファイルが使われます。
        </p>
        <pre>{`{
  "extends": "generic",
  "columns": [
    { "match": "index" },
    { "match": "result", "badge": { "ok": "green", "ng": "red", "skip": "gray" } },
    { "match": "Steps", "width": 520 }
  ]
}`}</pre>
        <p>
          <code>match</code> は列名（大文字・小文字と空白の違いは無視）または <code>/正規表現/</code> です。ルールを指定した列は自動判定の対象外になるので、見た目が固定されます。指定できる項目は README を参照してください。
        </p>
      </>
    ),
  },
];

export function GuideDialog({ onClose }: { onClose: () => void }) {
  const [active, setActive] = useState(GUIDE[0].id);
  const section = GUIDE.find((g) => g.id === active) ?? GUIDE[0];
  return (
    <Modal title="ヘルプ" onClose={onClose} className="guide">
      <div className="guide-body">
        <nav aria-label="ヘルプの目次">
          {GUIDE.map((g) => (
            <button key={g.id} className={g.id === active ? "active" : undefined} aria-current={g.id === active} onClick={() => setActive(g.id)}>
              {g.title}
            </button>
          ))}
        </nav>
        <article>
          <h3>{section.title}</h3>
          {section.body}
        </article>
      </div>
    </Modal>
  );
}
