import { markSaved, type CsvDoc } from "../csv/document";

/**
 * Undo/redo over immutable document snapshots. Records are shared between
 * snapshots, so each entry costs one array of pointers.
 */
export interface EditorState {
  doc: CsvDoc;
  past: CsvDoc[];
  future: CsvDoc[];
  /** Short description of the last change, shown in the status bar. */
  lastAction?: string;
}

export type EditorAction =
  | { type: "load"; doc: CsvDoc }
  | { type: "apply"; label: string; update: (doc: CsvDoc) => CsvDoc }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saved" };

const LIMIT = 300;

export function initialEditorState(doc: CsvDoc): EditorState {
  return { doc, past: [], future: [] };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load":
      return initialEditorState(action.doc);
    case "apply": {
      const next = action.update(state.doc);
      if (next === state.doc) return state;
      const past = [...state.past, state.doc];
      if (past.length > LIMIT) past.shift();
      return { doc: next, past, future: [], lastAction: action.label };
    }
    case "undo": {
      if (state.past.length === 0) return state;
      const doc = state.past[state.past.length - 1];
      return { doc, past: state.past.slice(0, -1), future: [state.doc, ...state.future], lastAction: "元に戻す" };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const [doc, ...future] = state.future;
      return { doc, past: [...state.past, state.doc], future, lastAction: "やり直す" };
    }
    case "saved": {
      // Every snapshot compares against the new baseline from now on.
      const saved = markSaved(state.doc);
      const rebase = (d: CsvDoc): CsvDoc => ({ ...d, originals: saved.originals, originalOrder: saved.originalOrder });
      return { doc: saved, past: state.past.map(rebase), future: state.future.map(rebase), lastAction: "保存しました" };
    }
  }
}
