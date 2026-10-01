import type { Theme } from "@glideapps/glide-data-grid";
import { HUES, type ColorToken, type Hue } from "../rules/schema";

export type ThemeMode = "light" | "dark";

interface HueColors {
  /** Badge / chip background */
  bg: string;
  /** Badge / chip text */
  fg: string;
  /** Cell or row background tint */
  soft: string;
}

const PALETTE: Record<ThemeMode, Record<Hue, HueColors>> = {
  light: {
    green: { bg: "#dcfce7", fg: "#166534", soft: "#f3fbf5" },
    red: { bg: "#fee2e2", fg: "#b91c1c", soft: "#fef4f4" },
    amber: { bg: "#fef3c7", fg: "#92400e", soft: "#fffbeb" },
    blue: { bg: "#e0ecff", fg: "#1d4ed8", soft: "#f2f7ff" },
    purple: { bg: "#ede9fe", fg: "#6d28d9", soft: "#f7f5ff" },
    teal: { bg: "#ccfbf1", fg: "#0f766e", soft: "#f0fdfa" },
    pink: { bg: "#fce7f3", fg: "#be185d", soft: "#fdf2f8" },
    orange: { bg: "#ffedd5", fg: "#c2410c", soft: "#fff7ed" },
    gray: { bg: "#eef1f5", fg: "#475569", soft: "#f8fafc" },
  },
  dark: {
    green: { bg: "#1b4332", fg: "#86efac", soft: "#16231c" },
    red: { bg: "#5c1d1d", fg: "#fca5a5", soft: "#2a1618" },
    amber: { bg: "#5a3a0e", fg: "#fcd34d", soft: "#272114" },
    blue: { bg: "#1e3561", fg: "#9ec3ff", soft: "#151d2c" },
    purple: { bg: "#3b2470", fg: "#c4b5fd", soft: "#1d192b" },
    teal: { bg: "#134e4a", fg: "#5eead4", soft: "#132422" },
    pink: { bg: "#5f1838", fg: "#f9a8d4", soft: "#26151e" },
    orange: { bg: "#5f2a0f", fg: "#fdba74", soft: "#271a12" },
    gray: { bg: "#2f3744", fg: "#cbd5e1", soft: "#1b1f26" },
  },
};

export interface UiColors {
  bg: string;
  bgAlt: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  link: string;
  linkBroken: string;
  dirty: string;
  chip: Record<"var" | "literal" | "param", HueColors>;
}

const UI: Record<ThemeMode, UiColors> = {
  light: {
    bg: "#ffffff",
    bgAlt: "#f8fafc",
    text: "#1f2937",
    textMuted: "#8a94a3",
    border: "#e3e7ee",
    accent: "#2563eb",
    link: "#1d4ed8",
    linkBroken: "#dc2626",
    dirty: "#f59e0b",
    chip: { var: PALETTE.light.blue, literal: PALETTE.light.orange, param: PALETTE.light.purple },
  },
  dark: {
    bg: "#16181d",
    bgAlt: "#1b1e24",
    text: "#e5e7eb",
    textMuted: "#7f8896",
    border: "#2a2f38",
    accent: "#60a5fa",
    link: "#8ab4ff",
    linkBroken: "#f87171",
    dirty: "#fbbf24",
    chip: { var: PALETTE.dark.blue, literal: PALETTE.dark.orange, param: PALETTE.dark.purple },
  },
};

export function uiColors(mode: ThemeMode): UiColors {
  return UI[mode];
}

export function hueColors(mode: ThemeMode, hue: Hue): HueColors {
  return PALETTE[mode][hue];
}

function isHue(s: string): s is Hue {
  return (HUES as readonly string[]).includes(s);
}

/** Text color for a token, or undefined for the default. */
export function textColor(mode: ThemeMode, token: ColorToken | undefined): string | undefined {
  if (!token || token === "default") return undefined;
  if (token === "muted") return UI[mode].textMuted;
  const hue = token.replace(/-soft$/, "");
  return isHue(hue) ? PALETTE[mode][hue].fg : undefined;
}

/** Background color for a token, or undefined for the default. */
export function backgroundColor(mode: ThemeMode, token: ColorToken | undefined): string | undefined {
  if (!token || token === "default" || token === "muted") return undefined;
  if (token.endsWith("-soft")) {
    const hue = token.slice(0, -5);
    return isHue(hue) ? PALETTE[mode][hue].soft : undefined;
  }
  return isHue(token) ? PALETTE[mode][token].bg : undefined;
}

/** Stable color for an arbitrary value (labels, auto badges). */
export function hashedHue(value: string): Hue {
  const choices = HUES.filter((h) => h !== "gray");
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return choices[h % choices.length];
}

export function badgeColors(mode: ThemeMode, token: ColorToken | undefined, value: string): HueColors {
  const hue = token ? token.replace(/-soft$/, "") : hashedHue(value);
  return PALETTE[mode][isHue(hue) ? hue : hashedHue(value)];
}

export const FONT_SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", Meiryo, Roboto, sans-serif';
export const FONT_MONO =
  'ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, "Noto Sans Mono CJK JP", monospace';

export function gridTheme(mode: ThemeMode): Partial<Theme> {
  const c = UI[mode];
  const dark = mode === "dark";
  return {
    accentColor: c.accent,
    accentFg: "#ffffff",
    accentLight: dark ? "rgba(96,165,250,0.18)" : "rgba(37,99,235,0.10)",
    textDark: c.text,
    textMedium: dark ? "#b3bac6" : "#4b5563",
    textLight: c.textMuted,
    textBubble: c.text,
    bgIconHeader: dark ? "#9aa3b2" : "#64748b",
    fgIconHeader: dark ? "#16181d" : "#ffffff",
    textHeader: dark ? "#c9d1dc" : "#334155",
    textHeaderSelected: "#ffffff",
    bgCell: c.bg,
    bgCellMedium: c.bgAlt,
    bgHeader: dark ? "#1c1f26" : "#f6f8fb",
    bgHeaderHasFocus: dark ? "#262a33" : "#e9eef6",
    bgHeaderHovered: dark ? "#232731" : "#eef2f7",
    bgBubble: dark ? "#262a33" : "#eef2f7",
    bgBubbleSelected: c.accent,
    bgSearchResult: dark ? "#5a4a12" : "#fff3b0",
    borderColor: c.border,
    horizontalBorderColor: c.border,
    drilldownBorder: c.border,
    linkColor: c.link,
    cellHorizontalPadding: 10,
    cellVerticalPadding: 8,
    headerFontStyle: "600 12.5px",
    baseFontStyle: "13px",
    markerFontStyle: "11px",
    fontFamily: FONT_SANS,
    editorFontSize: "13px",
    lineHeight: 1.5,
  };
}
