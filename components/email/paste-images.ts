// Excel and Word put a rendered picture of the selection on the clipboard
// next to the HTML. Pasting that picture loses the cells (#1233), so the
// HTML wins when it holds a table or comes from an Office document. A copied
// picture alone, or a web image (an <img> plus the image file), still pastes
// as an image.
const OFFICE_DOCUMENT = /<meta[^>]+name=["']?ProgId["']?[^>]+content=["']?(?:Excel\.Sheet|Word\.Document)/i;
const TABLE = /<table[\s>]/i;

export function prefersPastedHtml(html: string): boolean {
  return TABLE.test(html) || OFFICE_DOCUMENT.test(html) || /<(?:p|h[1-6]|ul|ol|blockquote)[\s>]/i.test(html);
}

/** The image files a paste should upload, or none to let the editor parse it. */
export function pastedImageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data?.files?.length) return [];
  const images = Array.from(data.files).filter((f) => f.type.startsWith("image/"));
  if (images.length === 0) return [];
  if (prefersPastedHtml(data.getData("text/html"))) return [];
  return images;
}
