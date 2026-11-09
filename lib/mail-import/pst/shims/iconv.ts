// `iconv-lite` for pst-extractor, which only calls decode(bytes, codepage).
// TextDecoder knows the WHATWG labels (windows-125x, iso-8859-x, shift_jis,
// gbk, big5, ...) and keeps iconv-lite's 490 KB of tables out of the worker.
export function decode(data: Uint8Array, codepage: string): string {
  let label = String(codepage || "utf-8").toLowerCase();
  if (label === "utf8") label = "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder("windows-1252");
  }
  return decoder.decode(data);
}

export default { decode };
