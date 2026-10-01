import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
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
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
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
  ["行番号をドラッグ", "行を移動（並べ替え・絞り込み中は不可）"],
  ["列見出しをドラッグ", "列を移動"],
  ["case-N をクリック", "そのケースへジャンプ"],
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
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
