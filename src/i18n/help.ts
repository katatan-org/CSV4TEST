import type { ReactNode } from "react";
import { helpEn } from "./help.en";
import { helpJa } from "./help.ja";
import type { Locale } from "./types";

export interface GuideSection {
  id: string;
  title: string;
  body: ReactNode;
}

/** Long-form help per language (see help.ja.tsx). */
export interface HelpContent {
  /** [keys, description] */
  shortcuts: [string, string][];
  shortcutsNote: string;
  guide: GuideSection[];
  welcomePoints: ReactNode[];
}

export const HELP: Record<Locale, HelpContent> = { ja: helpJa, en: helpEn };
