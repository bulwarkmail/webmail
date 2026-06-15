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

/** A composer recipient. Display name is optional; email is required. */
export type Recipient = { name?: string; email: string };

/**
 * Splits a comma-separated recipient string into individual entries. Commas
 * inside a quoted display name (`"Doo, John" <john@doo.org>`) or angle brackets
 * (`<a,b@x>`) are treated as literal, not separators. Only used at the
 * (de)serialization boundary — the live composer state is an array, so the UI
 * never round-trips through this. Trims each part and drops empties.
 */
export function splitRecipients(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;
  for (const ch of value) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === '<' && !inQuotes) {
      inAngle = true;
      current += ch;
    } else if (ch === '>' && !inQuotes) {
      inAngle = false;
      current += ch;
    } else if (ch === ',' && !inQuotes && !inAngle) {
      const trimmed = current.trim();
      if (trimmed) result.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) result.push(trimmed);
  return result;
}

// Display names containing any of these must be wrapped in a quoted-string so
// they survive comma-splitting at the serialization boundary and round-trip.
const NAME_NEEDS_QUOTING = /[,<>"@;:]/;

/**
 * Formats a recipient as a string. Bare email when there's no distinct name;
 * otherwise `Name <email>`, RFC 5322 quoting the name when it contains a comma
 * or other special character.
 */
export function formatRecipient(name: string | undefined, email: string): string {
  const trimmedName = name?.trim();
  if (!trimmedName || trimmedName === email) return email;
  const quoted = NAME_NEEDS_QUOTING.test(trimmedName)
    ? `"${trimmedName.replace(/(["\\])/g, '\\$1')}"`
    : trimmedName;
  return `${quoted} <${email}>`;
}

/** Strips a surrounding quoted-string (and its escapes) from a display name. */
function unquoteName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return trimmed;
}

/**
 * Parses a single recipient string (`Name <email>`, `"Quoted, Name" <email>`,
 * or bare `email`) into a {@link Recipient}. The display name is unquoted.
 */
export function parseRecipient(s: string): Recipient {
  const trimmed = s.trim();
  const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
  if (angleMatch) {
    return { name: unquoteName(angleMatch[1]), email: angleMatch[2].trim() };
  }
  return { email: trimmed };
}

/** Parses a serialized comma-separated recipient string into an array. */
export function parseRecipientList(value: string): Recipient[] {
  return splitRecipients(value).map(parseRecipient);
}

/** Serializes a recipient array into a comma-separated string. */
export function formatRecipientList(recipients: Recipient[]): string {
  return recipients.map((r) => formatRecipient(r.name, r.email)).join(', ');
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
