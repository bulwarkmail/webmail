// `zlib` for pst-extractor: it only inflates the compressed blocks of OST 2013 files.
import { decompressSync } from "fflate";
import { Buffer } from "buffer";

export function unzipSync(data: Uint8Array): Buffer {
  return Buffer.from(decompressSync(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
}

export default { unzipSync };
