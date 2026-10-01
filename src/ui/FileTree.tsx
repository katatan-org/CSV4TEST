import { useState } from "react";
import type { TreeNode } from "../fs/fileAccess";
import { Icon } from "./icons";

export function FileTree({
  tree,
  activePath,
  dirty,
  onOpen,
  onRefresh,
}: {
  tree: TreeNode;
  activePath: string | null;
  dirty: boolean;
  onOpen: (node: TreeNode) => void;
  onRefresh: () => void;
}) {
  return (
    <nav className="file-tree" aria-label="CSVファイル">
      <header>
        <Icon name="folder" />
        <span className="file-tree-root" title={tree.name}>
          {tree.name}
        </span>
        <button className="icon-button" onClick={onRefresh} title="再読み込み" aria-label="フォルダを再読み込み">
          <Icon name="refresh" size={14} />
        </button>
      </header>
      {tree.children && tree.children.length > 0 ? (
        <ul>
          {tree.children.map((n) => (
            <Node key={n.path} node={n} activePath={activePath} dirty={dirty} onOpen={onOpen} depth={0} />
          ))}
        </ul>
      ) : (
        <p className="empty">CSVファイルが見つかりません</p>
      )}
    </nav>
  );
}

function Node({
  node,
  activePath,
  dirty,
  onOpen,
  depth,
}: {
  node: TreeNode;
  activePath: string | null;
  dirty: boolean;
  onOpen: (node: TreeNode) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2 || (activePath?.startsWith(node.path + "/") ?? false));
  const pad = { paddingLeft: 8 + depth * 14 };
  if (node.kind === "dir") {
    return (
      <li>
        <button className="tree-item" style={pad} onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
          <span>{node.name}</span>
        </button>
        {open && (
          <ul>
            {node.children?.map((c) => (
              <Node key={c.path} node={c} activePath={activePath} dirty={dirty} onOpen={onOpen} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  }
  const active = node.path === activePath;
  return (
    <li>
      <button
        className={`tree-item file${active ? " active" : ""}`}
        style={pad}
        onClick={() => onOpen(node)}
        aria-current={active ? "page" : undefined}
        title={node.path}
      >
        <Icon name="file" size={13} />
        <span>{node.name}</span>
        {active && dirty && <span className="dirty-dot" aria-label="未保存" />}
      </button>
    </li>
  );
}
