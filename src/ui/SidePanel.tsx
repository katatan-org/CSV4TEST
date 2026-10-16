import type { ChangeSummary } from "../editor/changes";
import { useI18n, type Messages } from "../i18n";
import type { Issue, VariableUse } from "../rules/analysis";
import type { ResolvedRules } from "../rules/detect";
import { PRESETS } from "../rules/detect";
import { Icon, type IconName } from "./icons";

export type PanelTab = "issues" | "changes" | "variables" | "labels" | "rules";

export interface SidePanelProps {
  tab: PanelTab;
  onTab(tab: PanelTab): void;
  onClose(): void;
  issues: Issue[];
  variables: VariableUse[];
  /** Variables defined by the backend (e.g. a dictionary); undefined when it has none. */
  definedVariables?: ReadonlyMap<string, string | undefined>;
  labels: { name: string; count: number; color: { bg: string; fg: string } }[];
  activeLabels: string[];
  onToggleLabel(name: string): void;
  changes: ChangeSummary;
  /** Display names of the current columns. */
  headers: string[];
  /** Display name of a column header (see Editor columnLabels); `col` is used when the header is empty. */
  columnLabel(header: string, col: number): string;
  canSave: boolean;
  onSave(): void;
  onJump(recordId: number, col?: number): void;
  describeRecord(recordId: number): string;
  onFilterText(text: string): void;
  rules: ResolvedRules;
  presetChoice: string;
  onPreset(name: string): void;
  override: { path?: string; error?: string };
  missingOptional: string[];
  onAddOptional(name: string): void;
  hasLabels: boolean;
  hasVariables: boolean;
}

const TABS: { id: PanelTab; label: (m: Messages) => string; icon: IconName }[] = [
  { id: "issues", label: (m) => m.tabIssues, icon: "alert" },
  { id: "changes", label: (m) => m.tabChanges, icon: "diff" },
  { id: "variables", label: (m) => m.tabVariables, icon: "braces" },
  { id: "labels", label: (m) => m.tabLabels, icon: "tag" },
  { id: "rules", label: (m) => m.tabRules, icon: "rules" },
];

export function SidePanel(p: SidePanelProps) {
  const { m, number } = useI18n();
  const counts: Partial<Record<PanelTab, number>> = {
    issues: p.issues.length,
    changes: p.changes.changes.length + (p.changes.reordered ? 1 : 0),
    variables: p.variables.length,
    labels: p.labels.length,
  };
  const tabs = TABS.filter((t) => (t.id === "variables" ? p.hasVariables : t.id === "labels" ? p.hasLabels : true));
  return (
    <aside className="side-panel" aria-label={m.sidePanel}>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={p.tab === t.id} className={p.tab === t.id ? "active" : undefined} onClick={() => p.onTab(t.id)} title={t.label(m)}>
            <Icon name={t.icon} size={14} />
            <span>{t.label(m)}</span>
            {counts[t.id] ? <span className={`count${t.id === "issues" ? " warn" : t.id === "changes" ? " dirty" : ""}`}>{number(counts[t.id]!)}</span> : null}
          </button>
        ))}
        <button className="icon-button close" onClick={p.onClose} aria-label={m.closePanel}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="panel-body">
        {p.tab === "issues" && <IssuesTab {...p} />}
        {p.tab === "changes" && <ChangesTab {...p} />}
        {p.tab === "variables" && <VariablesTab {...p} />}
        {p.tab === "labels" && <LabelsTab {...p} />}
        {p.tab === "rules" && <RulesTab {...p} />}
      </div>
    </aside>
  );
}

function IssuesTab({ issues, onJump, describeRecord, headers }: SidePanelProps) {
  const { m } = useI18n();
  if (issues.length === 0) return <p className="empty ok">{m.noIssues}</p>;
  return (
    <ul className="issue-list">
      {issues.map((issue, i) => (
        <li key={i}>
          <button disabled={issue.recordId === undefined} onClick={() => issue.recordId !== undefined && onJump(issue.recordId, issue.col)}>
            <span className={`sev ${issue.severity}`}>{issue.severity === "error" ? m.severityError : m.severityWarning}</span>
            <span className="issue-msg">{issue.message}</span>
            {issue.recordId !== undefined && (
              <span className="issue-loc">
                {describeRecord(issue.recordId)}
                {issue.col !== undefined && headers[issue.col] ? ` · ${headers[issue.col]}` : ""}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ChangesTab({ changes, onJump, describeRecord, canSave, onSave, columnLabel }: SidePanelProps) {
  const { m } = useI18n();
  const { changes: list, reordered, dirtyCells, columns } = changes;
  if (list.length === 0 && !reordered) return <p className="empty ok">{m.noChanges}</p>;
  const names = (headers: string[]) => headers.map((h) => columnLabel(h, -1)).join(m.listSeparator);
  const columnNote = [
    columns.added.length > 0 ? m.columnsAdded({ columns: names(columns.added) }) : "",
    columns.removed.length > 0 ? m.columnsRemoved({ columns: names(columns.removed) }) : "",
  ].filter(Boolean);
  return (
    <div className="changes">
      <div className="changes-summary">
        <span>
          {m.changeCounts({ rows: list.length, cells: dirtyCells })}
          {reordered ? m.rowsReordered : ""}
        </span>
        <button className="primary small" onClick={onSave} disabled={!canSave}>
          <Icon name="save" size={13} />
          {m.save}
        </button>
      </div>
      {columnNote.length > 0 && (
        <p className="panel-hint warn-note">
          {m.columnsChangedNote({ changes: columnNote.join(m.bulletSeparator) })}
        </p>
      )}
      <ul className="change-list">
        {list.map((c) => (
          <li key={`${c.kind}-${c.record.id}`} className={c.kind}>
            <button disabled={c.kind === "removed"} onClick={() => onJump(c.record.id, c.cells[0]?.col)}>
              <span className={`change-kind ${c.kind}`}>{c.kind === "added" ? m.changeAdded : c.kind === "removed" ? m.changeRemoved : m.changeModified}</span>
              <span className="change-row">{c.kind === "removed" ? m.originalRow({ n: c.index }) : describeRecord(c.record.id)}</span>
            </button>
            {c.kind === "modified" && (
              <dl>
                {c.cells.map((cell) => (
                  <div key={`${cell.col}:${cell.header}`}>
                    <dt>
                      {columnLabel(cell.header, cell.col)}
                      {cell.col < 0 ? m.removedColumn : ""}
                    </dt>
                    <dd>
                      <del>{cell.before || m.emptyValue}</del>
                      <ins>{cell.after || m.emptyValue}</ins>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {c.kind !== "modified" && (
              <p className="change-preview">{c.cells.map((x) => x.after || x.before).filter(Boolean).slice(0, 3).join(m.bulletSeparator)}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function VariablesTab({ variables, definedVariables, onFilterText }: SidePanelProps) {
  const { m } = useI18n();
  if (variables.length === 0) return <p className="empty">{m.noVariables}</p>;
  return (
    <>
      <p className="panel-hint">{m.variablesHint}</p>
      <ul className="var-list">
        {variables.map((v) => (
          <li key={v.name}>
            <button onClick={() => onFilterText(`{{${v.name}}}`)}>
              <code>{`{{${v.name}}}`}</code>
              <span className="count">{m.rowCount({ count: v.recordIds.length })}</span>
              {definedVariables && (
                <span className={`var-value${definedVariables.has(v.name) ? "" : " undefined"}`}>
                  {definedVariables.has(v.name) ? (definedVariables.get(v.name) ?? "") : m.undefinedVariable}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function LabelsTab({ labels, activeLabels, onToggleLabel }: SidePanelProps) {
  const { m, number } = useI18n();
  if (labels.length === 0) return <p className="empty">{m.noLabels}</p>;
  return (
    <>
      <p className="panel-hint">{m.labelsHint}</p>
      <div className="label-chips">
        {labels.map((l) => {
          const on = activeLabels.includes(l.name);
          return (
            <button
              key={l.name}
              className={`label-chip${on ? " on" : ""}`}
              style={{ background: l.color.bg, color: l.color.fg }}
              aria-pressed={on}
              onClick={() => onToggleLabel(l.name)}
            >
              {l.name}
              <span className="count">{number(l.count)}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function RulesTab({ rules, presetChoice, onPreset, override, missingOptional, onAddOptional, columnLabel }: SidePanelProps) {
  const { m } = useI18n();
  return (
    <div className="rules-tab">
      <label className="field">
        {m.rulesLabel}
        <select value={presetChoice} onChange={(e) => onPreset(e.target.value)}>
          <option value="auto">{m.autoDetect({ preset: rules.ruleSet.name })}</option>
          {PRESETS.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name === "katatan" ? m.presetKatatanCases : m.presetGeneric}
            </option>
          ))}
        </select>
      </label>
      {override.path && (
        <p className="panel-hint">{m.overrideApplied({ path: override.path })}</p>
      )}
      {override.error && <p className="error-text">{m.overrideError({ detail: override.error })}</p>}
      {missingOptional.length > 0 && (
        <div className="optional-cols">
          {missingOptional.map((name) => (
            <button key={name} className="small" onClick={() => onAddOptional(name)}>
              <Icon name="plus" size={13} />
              {m.addColumnButton({ name })}
            </button>
          ))}
        </div>
      )}
      <table className="rule-table">
        <thead>
          <tr>
            <th>{m.ruleColumn}</th>
            <th>{m.ruleDisplay}</th>
          </tr>
        </thead>
        <tbody>
          {rules.columns.map((c) => (
            <tr key={c.index}>
              <td>{columnLabel(c.header, c.index)}</td>
              <td>{describeRule(c.rule, m)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="panel-hint">
        <summary>{m.customizeRules}</summary>
        <p>{m.customizeRulesHint}</p>
        <pre>{`{
  "extends": "katatan",
  "columns": [
    { "match": "Steps", "width": 520 },
    { "match": "Priority", "badge": { "High": "red", "Low": "gray" } }
  ],
  "labelColors": { "Smoke": "teal" }
}`}</pre>
      </details>
    </div>
  );
}

function describeRule(rule: ResolvedRules["columns"][number]["rule"], m: Messages): string {
  const parts: string[] = [];
  const display: Record<string, string> = { steps: m.ruleSteps, labels: m.ruleLabels, images: m.ruleImages, id: m.ruleId };
  if (rule.display && display[rule.display]) parts.push(display[rule.display]);
  if (rule.badge) parts.push(m.ruleBadge);
  if (rule.wrap) parts.push(m.ruleWrap);
  if (rule.tokens) parts.push(m.ruleTokens);
  if (rule.pinned) parts.push(m.rulePinned);
  if (rule.align === "right") parts.push(m.ruleAlignRight);
  if (rule.font === "mono") parts.push(m.ruleMono);
  if (rule.format) parts.push(m.ruleFormat({ format: rule.format.replace("{value}", "…") }));
  return parts.join(m.bulletSeparator) || m.ruleText;
}
