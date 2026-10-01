import { useEffect, useMemo, useRef, useState } from "react";
import { cellValue, type CellEdit } from "../csv/document";
import type { CsvRecord } from "../csv/types";
import { buildPattern, findMatches, replaceAll, type FindOptions, type Match } from "../editor/findReplace";
import { Icon } from "./icons";

export function FindBar({
  rows,
  colCount,
  headers,
  replaceMode,
  onReplaceMode,
  onJump,
  onReplace,
  onMatches,
  onClose,
}: {
  rows: CsvRecord[];
  colCount: number;
  headers: string[];
  replaceMode: boolean;
  onReplaceMode(on: boolean): void;
  onJump(m: Match): void;
  onReplace(edits: CellEdit[], label: string): void;
  onMatches(matches: Match[]): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [column, setColumn] = useState<number | "all">("all");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [replaceMode]);

  const opts: FindOptions = useMemo(
    () => ({ regex, caseSensitive, columns: column === "all" ? undefined : [column] }),
    [regex, caseSensitive, column],
  );
  const pattern = useMemo(() => (query === "" ? null : buildPattern(query, opts)), [query, opts]);
  const matches = useMemo(
    () => (pattern instanceof RegExp ? findMatches(rows, colCount, pattern, opts) : []),
    [pattern, rows, colCount, opts],
  );

  useEffect(() => {
    onMatches(matches);
  }, [matches, onMatches]);
  useEffect(() => () => onMatches([]), [onMatches]);
  useEffect(() => setIndex(0), [query, opts]);

  const go = (delta: number) => {
    if (matches.length === 0) return;
    const i = (index + delta + matches.length) % matches.length;
    setIndex(i);
    onJump(matches[i]);
  };

  const replaceOne = () => {
    if (!(pattern instanceof RegExp) || matches.length === 0) return;
    const m = matches[Math.min(index, matches.length - 1)];
    const record = rows.find((r) => r.id === m.recordId);
    if (!record) return;
    onReplace([{ recordId: m.recordId, col: m.col, value: replaceAll(cellValue(record, m.col), pattern, replacement, opts) }], "置換");
    onJump(m);
  };

  const replaceEvery = () => {
    if (!(pattern instanceof RegExp) || matches.length === 0) return;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const edits = matches.map((m) => ({
      recordId: m.recordId,
      col: m.col,
      value: replaceAll(cellValue(byId.get(m.recordId), m.col), pattern, replacement, opts),
    }));
    onReplace(edits, `${edits.length}セルを置換`);
  };

  const error = typeof pattern === "string" ? pattern : null;

  return (
    <div
      className="find-bar"
      role="search"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="find-row">
        <button className="icon-button" onClick={() => onReplaceMode(!replaceMode)} aria-label="置換の表示切り替え" aria-expanded={replaceMode}>
          <Icon name={replaceMode ? "chevronDown" : "chevronRight"} size={14} />
        </button>
        <input
          ref={input}
          value={query}
          placeholder="検索"
          aria-label="検索語"
          aria-invalid={!!error}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <button className={`toggle${caseSensitive ? " on" : ""}`} onClick={() => setCaseSensitive(!caseSensitive)} title="大文字と小文字を区別" aria-pressed={caseSensitive}>
          Aa
        </button>
        <button className={`toggle${regex ? " on" : ""}`} onClick={() => setRegex(!regex)} title="正規表現" aria-pressed={regex}>
          .*
        </button>
        <select value={column} onChange={(e) => setColumn(e.target.value === "all" ? "all" : Number(e.target.value))} aria-label="検索する列">
          <option value="all">すべての列</option>
          {headers.map((h, i) => (
            <option key={i} value={i}>
              {h || `列 ${i + 1}`}
            </option>
          ))}
        </select>
        <span className={`find-count${error ? " error-text" : ""}`}>
          {error ?? (query === "" ? "" : matches.length === 0 ? "0件" : `${Math.min(index + 1, matches.length)} / ${matches.length}`)}
        </span>
        <button className="icon-button" onClick={() => go(-1)} disabled={matches.length === 0} aria-label="前へ">
          <Icon name="chevronLeft" size={14} style={{ transform: "rotate(90deg)" }} />
        </button>
        <button className="icon-button" onClick={() => go(1)} disabled={matches.length === 0} aria-label="次へ">
          <Icon name="chevronRight" size={14} style={{ transform: "rotate(90deg)" }} />
        </button>
        <button className="icon-button" onClick={onClose} aria-label="検索を閉じる">
          <Icon name="x" size={14} />
        </button>
      </div>
      {replaceMode && (
        <div className="find-row">
          <span className="find-spacer" />
          <input
            value={replacement}
            placeholder={regex ? "置換後（$1 などが使えます）" : "置換後"}
            aria-label="置換後の文字列"
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.ctrlKey || e.metaKey) replaceEvery();
                else replaceOne();
              }
            }}
          />
          <button onClick={replaceOne} disabled={matches.length === 0}>
            置換
          </button>
          <button onClick={replaceEvery} disabled={matches.length === 0}>
            すべて置換
          </button>
        </div>
      )}
    </div>
  );
}
