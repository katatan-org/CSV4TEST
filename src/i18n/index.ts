/**
 * UI language. No library: a catalog per language (`ja.ts` is the source,
 * `en.ts` is typed against it), resolved once per locale into an `I18n`
 * object. Hosts can override single messages (`messages`) and the names
 * shown for column headers (`columnLabels`) without touching the CSV.
 */
import { createContext, useContext } from "react";
import { StorageError } from "../storage/types";
import { en } from "./en";
import { ja } from "./ja";
import type { Locale, Messages } from "./types";

export type { Locale, MessageKey, Messages } from "./types";
export { en, ja };

export const LOCALES: readonly Locale[] = ["ja", "en"];
export const CATALOGS: Record<Locale, Messages> = { ja, en };

export interface I18n {
  locale: Locale;
  m: Messages;
  /** Formats a number for the locale (e.g. 1,234). */
  number(value: number): string;
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** The supported locale closest to a BCP 47 tag such as navigator.language ("ja-JP" → "ja"); English otherwise. */
export function matchLocale(tag: string | undefined): Locale {
  const base = tag?.toLowerCase().split("-")[0];
  return isLocale(base) ? base : "en";
}

export function createI18n(locale: Locale = "ja", overrides?: Partial<Messages>): I18n {
  const base = CATALOGS[locale] ?? ja;
  let m = base;
  if (overrides) {
    const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined && v !== null));
    m = { ...base, ...defined } as Messages;
  }
  const numbers = new Intl.NumberFormat(locale === "ja" ? "ja-JP" : "en-US");
  return { locale, m, number: (value) => numbers.format(value) };
}

/** Text for an error shown to the user: errors from the built-in storage are translated, others keep their message. */
export function errorText(error: unknown, m: Messages): string {
  if (error instanceof StorageError) {
    const p = error.params;
    switch (error.code) {
      case "not_found":
        return m.errorNotFound({ path: p.path ?? "" });
      case "permission_denied":
        return m.errorPermissionDenied;
      case "create_folder_failed":
        return m.errorCreateFolder({ path: p.path ?? "" });
      case "no_folder_picker":
        return m.errorNoFolderPicker;
      case "no_file_picker":
        return m.errorNoFilePicker;
      case "images_unavailable":
        return m.errorImagesUnavailable;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

const I18nContext = createContext<I18n>(createI18n("ja"));
export const I18nProvider = I18nContext.Provider;

export function useI18n(): I18n {
  return useContext(I18nContext);
}
