const HTML_ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
} as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    HTML_ESCAPE_MAP[char as keyof typeof HTML_ESCAPE_MAP]
  );
}

export function plainTextToComposerBody(text: string): string {
  if (!text) return "";

  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// Transparent 1x1 GIF used as a stand-in src while the real inline image is
// being fetched from JMAP. Browsers cannot render `cid:` URLs directly, so
// without this swap the editor would show a broken-image icon (issue #163).
export const INLINE_IMAGE_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * Rewrites `<img src="cid:xxx">` references into `<img src="<placeholder>" data-cid="xxx">`
 * so TipTap can render the editor (the original cid: URL would 404) while still
 * carrying the cid through edits. The placeholder is swapped to the actual
 * image data once the corresponding inline blob has been fetched.
 */
export function rewriteCidImagesForEditor(html: string): string {
  if (!html || html.indexOf("cid:") === -1) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  let touched = false;
  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (!/^cid:/i.test(src)) return;
    const cid = src.slice(4);
    if (!cid) return;
    if (!img.getAttribute("data-cid")) {
      img.setAttribute("data-cid", cid);
    }
    img.setAttribute("src", INLINE_IMAGE_PLACEHOLDER);
    touched = true;
  });
  return touched ? doc.body.innerHTML : html;
}

/**
 * Parses the chip array and trailing in-progress input text from a
 * comma-separated recipient field value (e.g. "Alice <a@x.com>, bob@x.com, b").
 * A trailing comma means "bob@x.com" is a committed chip and "b" is the live input.
 */
function parseFieldValue(fieldValue: string): { chips: string[]; inputText: string } {
  const allParts = fieldValue.split(',').map(s => s.trim()).filter(Boolean);
  const hasTrailingComma = fieldValue.trimEnd().endsWith(',');
  const chips = hasTrailingComma ? allParts : allParts.slice(0, -1);
  const inputText = hasTrailingComma ? '' : (allParts[allParts.length - 1] ?? '');
  return { chips, inputText };
}

function buildFieldValue(chips: string[], inputText: string): string {
  if (chips.length === 0) return inputText;
  return chips.join(', ') + ', ' + inputText;
}

/** Removes the first occurrence of `chip` from a recipient field value string. */
export function removeChipFromFieldValue(fieldValue: string, chip: string): string {
  const { chips, inputText } = parseFieldValue(fieldValue);
  const idx = chips.indexOf(chip);
  if (idx === -1) return fieldValue;
  const remaining = chips.filter((_, i) => i !== idx);
  return buildFieldValue(remaining, inputText);
}

/** Appends `chip` as a committed entry to a recipient field value string. */
export function addChipToFieldValue(fieldValue: string, chip: string): string {
  const { chips, inputText } = parseFieldValue(fieldValue);
  return buildFieldValue([...chips, chip], inputText);
}

/**
 * Replaces the placeholder src on `<img data-cid="...">` elements with the
 * resolved data URL once the inline blob has been fetched. Leaves images
 * whose src has been edited away from the placeholder/cid alone.
 */
export function replaceInlineImagePlaceholders(
  html: string,
  cidToDataUrl: Map<string, string>
): string {
  if (!html || cidToDataUrl.size === 0) return html;
  if (html.indexOf("data-cid") === -1) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  let changed = false;
  doc.querySelectorAll("img[data-cid]").forEach((img) => {
    const cid = img.getAttribute("data-cid");
    if (!cid) return;
    const dataUrl = cidToDataUrl.get(cid);
    if (!dataUrl) return;
    const currentSrc = img.getAttribute("src") || "";
    if (currentSrc !== INLINE_IMAGE_PLACEHOLDER && !/^cid:/i.test(currentSrc)) return;
    img.setAttribute("src", dataUrl);
    changed = true;
  });
  return changed ? doc.body.innerHTML : html;
}
