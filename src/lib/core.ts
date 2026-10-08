/**
 * Framework-free core: lossless CSV parsing / serialization, the document
 * model, change computation and the display rules. No React, no DOM, so a
 * server (e.g. KATATAN importing a CSV into a test report) can read CSVs exactly
 * the way the editor does.
 */
export { parseCsv, detectDelimiter } from "../csv/parser";
export { serializeCsv } from "../csv/serializer";
export { decodeBytes, encodeText, type TextEncodingName } from "../csv/encoding";
export * from "../csv/document";
export type { CsvField, CsvRecord, CsvLayout, ParsedCsv } from "../csv/types";
export { computeChanges, columnMapping, type RecordChange, type CellChange, type ChangeSummary } from "../editor/changes";
export { resolveRules, headersOf, findColumn, parseRuleOverride, type ResolvedRules, type RuleOverride } from "../rules/detect";
export { analyze, type Issue, type AnalyzeOptions } from "../rules/analysis";
export { cellLines } from "../rules/tokens";
export type { RuleSet, ResolvedColumn } from "../rules/schema";
