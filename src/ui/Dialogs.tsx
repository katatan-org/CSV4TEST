import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { HELP } from "../i18n/help";
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
  const { m } = useI18n();
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={["modal", wide && "wide", className].filter(Boolean).join(" ")} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label={m.close}>
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
  const { m } = useI18n();
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
            {m.cancel}
          </button>
          <button type="submit" className="primary">
            {request.confirmLabel ?? m.ok}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { m, locale } = useI18n();
  const help = HELP[locale];
  return (
    <Modal title={m.keyboardShortcuts} onClose={onClose} wide>
      <dl className="shortcuts">
        {help.shortcuts.map(([k, v]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="note">{help.shortcutsNote}</p>
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
  const { m, number } = useI18n();
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
          {number(index + 1)} / {number(images.length)}
        </span>
        {img.url && (
          <a className="icon-button" href={img.url} target="_blank" rel="noreferrer" aria-label={m.openInNewTab}>
            <Icon name="external" />
          </a>
        )}
        <button className="icon-button" onClick={onClose} aria-label={m.close}>
          <Icon name="x" />
        </button>
      </div>
      {img.url ? <img src={img.url} alt={img.path} /> : <p className="lightbox-missing">{m.imageUnavailable({ status: img.status === "missing" ? m.imageMissing : img.status === "loading" ? m.imageLoading : m.imageNeedsFolder })}</p>}
      {index > 0 && (
        <button className="lightbox-nav prev" onClick={() => onIndex(index - 1)} aria-label={m.previousImage}>
          <Icon name="chevronLeft" size={28} />
        </button>
      )}
      {index < images.length - 1 && (
        <button className="lightbox-nav next" onClick={() => onIndex(index + 1)} aria-label={m.nextImage}>
          <Icon name="chevronRight" size={28} />
        </button>
      )}
    </div>
  );
}

export function GuideDialog({ onClose }: { onClose: () => void }) {
  const { m, locale } = useI18n();
  const guide = HELP[locale].guide;
  const [active, setActive] = useState(guide[0].id);
  const section = guide.find((g) => g.id === active) ?? guide[0];
  return (
    <Modal title={m.help} onClose={onClose} className="guide">
      <div className="guide-body">
        <nav aria-label={m.helpToc}>
          {guide.map((g) => (
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
