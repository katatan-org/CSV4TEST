import type { RuleSet } from "../schema";

/** Test case files exported from / managed for KATATAN. */
export const katatanPreset: RuleSet = {
  name: "katatan",
  detect: {
    requiredHeaders: ["No", "Test Subject", "Preconditions", "Steps", "Expected Result", "Notes"],
  },
  columns: [
    { match: "No", width: 72, pinned: true, align: "center", bold: true, display: "id", format: "case-{value}" },
    { match: "Labels", width: 150, display: "labels" },
    { match: "Test Subject", width: 260, wrap: true, bold: true, tokens: true },
    { match: "Preconditions", width: 220, wrap: true, tokens: true },
    { match: "Steps", width: 420, wrap: true, display: "steps", tokens: true },
    { match: "Expected Result", width: 300, wrap: true, tokens: true, background: "green-soft" },
    { match: "Notes", width: 200, wrap: true, color: "muted", placeholder: "-", tokens: true },
    { match: "Images", width: 200, display: "images" },
  ],
  labelColors: {
    "Normal Case": "green",
    "Abnormal Case": "red",
    "Error Case": "red",
    "Boundary Case": "amber",
    Smoke: "blue",
    Regression: "purple",
  },
  infer: true,
  features: {
    idColumn: "No",
    caseRef: { pattern: "case-(\\d+)", idColumn: "No" },
    variables: true,
    images: { column: "Images", assetsDir: "{name}.assets" },
    optionalColumns: [
      { name: "Labels", after: "No" },
      { name: "Images", after: "Notes" },
    ],
  },
};
