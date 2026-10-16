import { useEffect, useMemo, useRef, useState } from "react";
import { cellValue, type CellEdit } from "../csv/document";
import type { CsvRecord } from "../csv/types";
import { buildPattern, findMatches, replaceAll, type FindOptions, type Match } from "../editor/findReplace";
import { useI18n } from "../i18n";
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
  /** Display names of the columns (see Editor columnLabels). */
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
  const { m } = useI18n();

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
    const match = matches[Math.min(index, matches.length - 1)];
    const record = rows.find((r) => r.id === match.recordId);
    if (!record) return;
    onReplace([{ recordId: match.recordId, col: match.col, value: replaceAll(cellValue(record, match.col), pattern, replacement, opts) }], m.replace);
    onJump(match);
  };

  const replaceEvery = () => {
    if (!(pattern instanceof RegExp) || matches.length === 0) return;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const edits = matches.map((x) => ({
      recordId: x.recordId,
      col: x.col,
      value: replaceAll(cellValue(byId.get(x.recordId), x.col), pattern, replacement, opts),
    }));
    onReplace(edits, m.replaceCells({ count: edits.length }));
  };

  const error = typeof pattern === "string" ? m.invalidRegex({ detail: pattern }) : null;

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
        <button className="icon-button" onClick={() => onReplaceMode(!replaceMode)} aria-label={m.toggleReplace} aria-expanded={replaceMode}>
          <Icon name={replaceMode ? "chevronDown" : "chevronRight"} size={14} />
        </button>
        <input
          ref={input}
          value={query}
          placeholder={m.findPlaceholder}
          aria-label={m.findQuery}
          aria-invalid={!!error}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <button className={`toggle${caseSensitive ? " on" : ""}`} onClick={() => setCaseSensitive(!caseSensitive)} title={m.matchCase} aria-pressed={caseSensitive}>
          Aa
        </button>
        <button className={`toggle${regex ? " on" : ""}`} onClick={() => setRegex(!regex)} title={m.useRegex} aria-pressed={regex}>
          .*
        </button>
        <select value={column} onChange={(e) => setColumn(e.target.value === "all" ? "all" : Number(e.target.value))} aria-label={m.findColumn}>
          <option value="all">{m.allColumns}</option>
          {headers.map((h, i) => (
            <option key={i} value={i}>
              {h}
            </option>
          ))}
        </select>
        <span className={`find-count${error ? " error-text" : ""}`}>
          {error ?? (query === "" ? "" : matches.length === 0 ? m.noMatches : m.matchPosition({ index: Math.min(index + 1, matches.length), total: matches.length }))}
        </span>
        <button className="icon-button" onClick={() => go(-1)} disabled={matches.length === 0} aria-label={m.previous}>
          <Icon name="chevronLeft" size={14} style={{ transform: "rotate(90deg)" }} />
        </button>
        <button className="icon-button" onClick={() => go(1)} disabled={matches.length === 0} aria-label={m.next}>
          <Icon name="chevronRight" size={14} style={{ transform: "rotate(90deg)" }} />
        </button>
        <button className="icon-button" onClick={onClose} aria-label={m.closeFind}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {replaceMode && (
        <div className="find-row">
          <span className="find-spacer" />
          <input
            value={replacement}
            placeholder={regex ? m.replacementPlaceholderRegex : m.replacementPlaceholder}
            aria-label={m.replacement}
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
            {m.replace}
          </button>
          <button onClick={replaceEvery} disabled={matches.length === 0}>
            {m.replaceAll}
          </button>
        </div>
      )}
    </div>
  );
}
