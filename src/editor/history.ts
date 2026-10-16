import { markSaved, setCells, type CellEdit, type CsvDoc } from "../csv/document";

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
  /** `label` is shown as the last action (in the UI language). */
  | { type: "undo"; label?: string }
  | { type: "redo"; label?: string }
  /**
   * A save finished. `doc` is the snapshot that was written (edits made while
   * saving stay unsaved); `assigned` are values the backend filled in, which
   * become part of the saved baseline.
   */
  | { type: "saved"; doc?: CsvDoc; assigned?: CellEdit[]; label?: string };

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
      return { doc, past: state.past.slice(0, -1), future: [state.doc, ...state.future], lastAction: action.label };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const [doc, ...future] = state.future;
      return { doc, past: [...state.past, state.doc], future, lastAction: action.label };
    }
    case "saved": {
      const snapshot = action.doc ?? state.doc;
      // Every snapshot compares against the new baseline from now on.
      const saved = markSaved(action.assigned?.length ? setCells(snapshot, action.assigned) : snapshot);
      const written = new Map(snapshot.records.map((r) => [r.id, r]));
      const rebase = (d: CsvDoc): CsvDoc => ({
        ...d,
        // Records untouched since the snapshot become the saved ones (with assigned values).
        records: d.records.map((r) => (written.get(r.id) === r ? (saved.originals.get(r.id) ?? r) : r)),
        originals: saved.originals,
        originalOrder: saved.originalOrder,
      });
      let doc = rebase(state.doc);
      // Records edited while saving still get the assigned values.
      const late = (action.assigned ?? []).filter((e) => {
        const r = doc.records.find((x) => x.id === e.recordId);
        return r !== undefined && r !== saved.originals.get(e.recordId);
      });
      if (late.length > 0) doc = setCells(doc, late);
      return { doc, past: state.past.map(rebase), future: state.future.map(rebase), lastAction: action.label };
    }
  }
}
