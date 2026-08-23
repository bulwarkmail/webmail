/**
 * Sniffs the real image MIME type from a blob's leading magic bytes, returning
 * null when the bytes aren't a recognizable image.
 *
 * Some clients (notably Foxmail 7.2) embed inline images as
 * `Content-Type: application/octet-stream` with no `Content-Disposition:
 * inline` - the cid reference in the HTML is the only signal they're meant to
 * render in-body (#543). The declared type can't be trusted in that case, so
 * callers look at the bytes themselves to build a usable data URL and to
 * re-attach the part with a correct `image/*` type when the reply is sent.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 4) return null;
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: 47 49 46 38 ("GIF8")
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  // WebP: "RIFF" ....  "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // BMP: 42 4D ("BM")
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  return null;
}
