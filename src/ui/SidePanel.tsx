import type { ChangeSummary } from "../editor/changes";
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
  headers: string[];
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

const TABS: { id: PanelTab; label: string; icon: IconName }[] = [
  { id: "issues", label: "検証", icon: "alert" },
  { id: "changes", label: "変更", icon: "diff" },
  { id: "variables", label: "変数", icon: "braces" },
  { id: "labels", label: "ラベル", icon: "tag" },
  { id: "rules", label: "表示ルール", icon: "rules" },
];

export function SidePanel(p: SidePanelProps) {
  const counts: Partial<Record<PanelTab, number>> = {
    issues: p.issues.length,
    changes: p.changes.changes.length + (p.changes.reordered ? 1 : 0),
    variables: p.variables.length,
    labels: p.labels.length,
  };
  const tabs = TABS.filter((t) => (t.id === "variables" ? p.hasVariables : t.id === "labels" ? p.hasLabels : true));
  return (
    <aside className="side-panel" aria-label="サイドパネル">
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={p.tab === t.id} className={p.tab === t.id ? "active" : undefined} onClick={() => p.onTab(t.id)} title={t.label}>
            <Icon name={t.icon} size={14} />
            <span>{t.label}</span>
            {counts[t.id] ? <span className={`count${t.id === "issues" ? " warn" : t.id === "changes" ? " dirty" : ""}`}>{counts[t.id]}</span> : null}
          </button>
        ))}
        <button className="icon-button close" onClick={p.onClose} aria-label="パネルを閉じる">
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
  if (issues.length === 0) return <p className="empty ok">問題は見つかりませんでした</p>;
  return (
    <ul className="issue-list">
      {issues.map((issue, i) => (
        <li key={i}>
          <button disabled={issue.recordId === undefined} onClick={() => issue.recordId !== undefined && onJump(issue.recordId, issue.col)}>
            <span className={`sev ${issue.severity}`}>{issue.severity === "error" ? "エラー" : "警告"}</span>
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

function ChangesTab({ changes, onJump, describeRecord, canSave, onSave }: SidePanelProps) {
  const { changes: list, reordered, dirtyCells, columns } = changes;
  if (list.length === 0 && !reordered) return <p className="empty ok">保存されていない変更はありません</p>;
  const columnNote = [
    columns.added.length > 0 ? `列を追加: ${columns.added.join(", ")}` : "",
    columns.removed.length > 0 ? `列を削除: ${columns.removed.join(", ")}` : "",
  ].filter(Boolean);
  return (
    <div className="changes">
      <div className="changes-summary">
        <span>
          {list.length}行 / {dirtyCells}セル
          {reordered ? " ・行の順序が変更" : ""}
        </span>
        <button className="primary small" onClick={onSave} disabled={!canSave}>
          <Icon name="save" size={13} />
          保存
        </button>
      </div>
      {columnNote.length > 0 && (
        <p className="panel-hint warn-note">
          {columnNote.join(" ・ ")}。列の構成が変わったため、保存するとファイルの全行が書き換わります。
        </p>
      )}
      <ul className="change-list">
        {list.map((c) => (
          <li key={`${c.kind}-${c.record.id}`} className={c.kind}>
            <button disabled={c.kind === "removed"} onClick={() => onJump(c.record.id, c.cells[0]?.col)}>
              <span className={`change-kind ${c.kind}`}>{c.kind === "added" ? "追加" : c.kind === "removed" ? "削除" : "変更"}</span>
              <span className="change-row">{c.kind === "removed" ? `元の ${c.index} 行目` : describeRecord(c.record.id)}</span>
            </button>
            {c.kind === "modified" && (
              <dl>
                {c.cells.map((cell) => (
                  <div key={`${cell.col}:${cell.header}`}>
                    <dt>
                      {cell.header || `列 ${cell.col + 1}`}
                      {cell.col < 0 ? "（削除された列）" : ""}
                    </dt>
                    <dd>
                      <del>{cell.before || "（空）"}</del>
                      <ins>{cell.after || "（空）"}</ins>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {c.kind !== "modified" && (
              <p className="change-preview">{c.cells.map((x) => x.after || x.before).filter(Boolean).slice(0, 3).join(" ・ ")}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function VariablesTab({ variables, definedVariables, onFilterText }: SidePanelProps) {
  if (variables.length === 0) return <p className="empty">{"{{変数}}"} は使われていません</p>;
  return (
    <>
      <p className="panel-hint">クリックすると、その変数を使う行だけを表示します。</p>
      <ul className="var-list">
        {variables.map((v) => (
          <li key={v.name}>
            <button onClick={() => onFilterText(`{{${v.name}}}`)}>
              <code>{`{{${v.name}}}`}</code>
              <span className="count">{v.recordIds.length}行</span>
              {definedVariables && (
                <span className={`var-value${definedVariables.has(v.name) ? "" : " undefined"}`}>
                  {definedVariables.has(v.name) ? (definedVariables.get(v.name) ?? "") : "未定義"}
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
  if (labels.length === 0) return <p className="empty">ラベルはまだありません。Labels列のセルに1行1ラベルで入力します。</p>;
  return (
    <>
      <p className="panel-hint">ラベルを選ぶと、そのラベルを持つ行だけを表示します（複数選択はOR）。</p>
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
              <span className="count">{l.count}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function RulesTab({ rules, presetChoice, onPreset, override, missingOptional, onAddOptional }: SidePanelProps) {
  return (
    <div className="rules-tab">
      <label className="field">
        表示ルール
        <select value={presetChoice} onChange={(e) => onPreset(e.target.value)}>
          <option value="auto">自動判定（{rules.ruleSet.name}）</option>
          {PRESETS.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name === "katatan" ? "KATATAN テストケース" : "汎用CSV"}
            </option>
          ))}
        </select>
      </label>
      {override.path && (
        <p className="panel-hint">
          <code>{override.path}</code> の設定を適用中
        </p>
      )}
      {override.error && <p className="error-text">.csvview.json を読み込めません: {override.error}</p>}
      {missingOptional.length > 0 && (
        <div className="optional-cols">
          {missingOptional.map((name) => (
            <button key={name} className="small" onClick={() => onAddOptional(name)}>
              <Icon name="plus" size={13} />
              {name} 列を追加
            </button>
          ))}
        </div>
      )}
      <table className="rule-table">
        <thead>
          <tr>
            <th>列</th>
            <th>表示</th>
          </tr>
        </thead>
        <tbody>
          {rules.columns.map((c) => (
            <tr key={c.index}>
              <td>{c.header || `(列 ${c.index + 1})`}</td>
              <td>{describeRule(c.rule)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="panel-hint">
        <summary>ルールをカスタマイズするには</summary>
        <p>
          CSVと同じフォルダ（または上位フォルダ）に <code>.csvview.json</code> を置くと、列ごとの幅・色・表示方法を上書きできます。
        </p>
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

function describeRule(rule: ResolvedRules["columns"][number]["rule"]): string {
  const parts: string[] = [];
  const display: Record<string, string> = { steps: "番号付き手順", labels: "ラベル", images: "画像", id: "ID" };
  if (rule.display && display[rule.display]) parts.push(display[rule.display]);
  if (rule.badge) parts.push("バッジ");
  if (rule.wrap) parts.push("折り返し");
  if (rule.tokens) parts.push("強調");
  if (rule.pinned) parts.push("固定");
  if (rule.align === "right") parts.push("右寄せ");
  if (rule.font === "mono") parts.push("等幅");
  if (rule.format) parts.push(`表示: ${rule.format.replace("{value}", "…")}`);
  return parts.join(" ・ ") || "テキスト";
}
