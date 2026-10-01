export type TextEncodingName = "utf-8" | "shift_jis";

/**
 * Decodes file bytes. UTF-8 (with or without BOM) is preferred; bytes that are
 * not valid UTF-8 are treated as Shift_JIS (CP932), the usual Excel encoding in Japan.
 * The BOM is kept in the returned text so the parser can record it.
 */
export function decodeBytes(bytes: Uint8Array): { text: string; encoding: TextEncodingName } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { text, encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("shift_jis").decode(bytes), encoding: "shift_jis" };
  }
}

/** Shift_JIS output needs encoding tables, so that library is only loaded when such a file is saved. */
export async function encodeText(text: string, encoding: TextEncodingName): Promise<Uint8Array<ArrayBuffer>> {
  if (encoding === "utf-8") return new TextEncoder().encode(text);
  const { default: Encoding } = await import("encoding-japanese");
  const codes = Encoding.convert(Encoding.stringToCode(text), { to: "SJIS", from: "UNICODE" });
  return Uint8Array.from(codes);
}
