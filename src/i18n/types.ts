import type { ja } from "./ja";

export type Locale = "ja" | "en";

/** Every UI message. The Japanese catalog is the source; other catalogs must have the same keys. */
export type Messages = typeof ja;
export type MessageKey = keyof Messages;
