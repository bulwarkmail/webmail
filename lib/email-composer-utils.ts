import { isValidEmail } from "@/lib/validation";
import { htmlToPlainText } from "@/lib/html-to-text";

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
 * Reduce a composer body to just the user-authored text for the attachment
 * reminder's keyword scan, dropping the quoted original of a reply/forward.
 *
 * Scanning the whole body triggered false positives whenever the quoted message
 * mentioned an attachment - common, since the original often did carry one, and
 * the default keyword list is broad and multilingual (#570). We strip:
 *   - HTML mode: the QuotedHtml island ([data-quoted-html]) and any <blockquote>
 *     (the wrapper used when the original had no HTML part), then convert to text.
 *   - Plain-text mode: lines prefixed with ">" (the reply quote).
 *   - Both modes: everything from the "Forwarded message" separator onward, which
 *     also removes the forwarded From/Date/Subject header lines and the bare
 *     forwarded original (which carries no blockquote/island wrapper).
 *
 * `forwardedSeparator` is the localized quote_header.forwarded_separator string;
 * pass it so the forward cut works in the active locale.
 */
export function extractUserAuthoredText(
  body: string,
  options: { plainTextMode: boolean; forwardedSeparator?: string }
): string {
  const { plainTextMode, forwardedSeparator } = options;

  let text: string;
  if (plainTextMode) {
    text = body
      .split("\n")
      .filter((line) => !/^\s*>/.test(line))
      .join("\n");
  } else {
    const doc = new DOMParser().parseFromString(`<body>${body}</body>`, "text/html");
    doc
      .querySelectorAll("[data-quoted-html], blockquote")
      .forEach((el) => el.remove());
    text = htmlToPlainText(doc.body.innerHTML, { paragraphSpacing: true });
  }

  // Cut everything from the forwarded-message separator onward. htmlToPlainText
  // collapses the separator's internal whitespace, so match with a
  // whitespace-flexible, regex-escaped pattern rather than an exact string.
  const trimmedSeparator = forwardedSeparator?.trim();
  if (trimmedSeparator) {
    const pattern = trimmedSeparator
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    const match = text.match(new RegExp(pattern));
    if (match && match.index !== undefined) {
      text = text.slice(0, match.index);
    }
  }

  return text;
}

/** A composer recipient. Display name is optional; email is required. */
export type Recipient = { name?: string; email: string };

/**
 * Splits a recipient string into individual entries on any character in
 * `separators`, treating those characters as literal when they sit inside a
 * quoted display name (`"Doo, John" <john@doo.org>`) or angle brackets
 * (`<a,b@x>`). Trims each part and drops empties.
 *
 * Defaults to comma-only, the (de)serialization boundary used by the composer
 * state and mailto handling. Pasted lists pass a wider set (see
 * {@link splitPasteEntries}) because they also use `;` and line breaks.
 */
export function splitRecipients(value: string, separators = ','): string[] {
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
    } else if (separators.includes(ch) && !inQuotes && !inAngle) {
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
 * Top-level split of a pasted block into recipient entries on commas,
 * semicolons and newlines (separators inside a quoted name or angle brackets
 * stay literal). Broader than the comma-only default of {@link splitRecipients}
 * because pasted lists also use `;` and line breaks as separators.
 */
function splitPasteEntries(value: string): string[] {
  return splitRecipients(value, ',;\n\r');
}

/**
 * Splits pasted text into recipient candidates and partitions them: valid email
 * addresses become `Recipient`s (deduped case-insensitively against
 * `existingEmails` and within the paste), and everything else is returned as
 * `invalid` for the caller to drop back into the input field.
 *
 * Handles both structured and bare lists, preserving display names:
 * - `"Name <email>"` (the whole recipient quoted), `Name <email>`, and
 *   `"Doe, John" <email>` entries are kept intact with their display name.
 * - Bare-address dumps (`a@x.com b@y.com`, spreadsheet columns, comma/space/
 *   semicolon/newline separated) split into one chip per address.
 * - A token wrapped in angle brackets (`<a@x.com>`) is unwrapped before
 *   validating, so an `a <a@x.com>` fragment still yields the address.
 */
export function splitPastedRecipients(
  text: string,
  existingEmails: string[] = [],
): { valid: Recipient[]; invalid: string[] } {
  const seen = new Set(existingEmails.map((e) => e.toLowerCase()));
  const valid: Recipient[] = [];
  const invalid: string[] = [];

  // Adds a recipient if its address is valid and unseen. Returns true when the
  // entry is fully handled (valid or a known duplicate) so the caller can stop.
  const tryAdd = (r: Recipient): boolean => {
    if (!isValidEmail(r.email)) return false;
    const key = r.email.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      valid.push(r.name ? { name: r.name, email: r.email } : { email: r.email });
    }
    return true;
  };

  // Split on commas, semicolons and newlines in a quote/angle-aware way so a
  // `"Doe, John" <j@x.com>` or fully-quoted `"Name <email>"` entry stays a
  // single recipient (separators inside the name or the address are literal).
  for (const entry of splitPasteEntries(text)) {
    // 1. Structured: `Name <email>`, a bare address, or the whole
    //    `Name <email>` wrapped in quotes (unwrap once and retry).
    if (tryAdd(parseRecipient(entry))) continue;
    const unwrapped = unquoteName(entry);
    if (unwrapped !== entry && tryAdd(parseRecipient(unwrapped))) continue;

    // 2. Fallback: a bare-address run (`a@x.com b@y.com`) or a
    //    `John Doe <j@x.com>` fragment where only the <addr> is valid.
    //    Whitespace/semicolon-tokenize; leftover tokens stay behind.
    for (const token of entry.split(/[\s;]+/).map((t) => t.trim()).filter(Boolean)) {
      if (!tryAdd({ email: token.replace(/^<|>$/g, '') })) invalid.push(token);
    }
  }

  return { valid, invalid };
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

export type PendingUploadLike = {
  uploading?: boolean;
  error?: boolean;
};

export type PendingUploadWaitResult = "completed" | "cancelled" | "failed";

/**
 * Wait for in-flight attachment uploads to settle before sending.
 *
 * Polls `getAttachments` until nothing is `uploading`, checking
 * `isCancelled` between polls (composer closed / draft discarded).
 * Resolves:
 * - "cancelled" - cancellation was signalled while waiting
 * - "failed"    - uploads settled but at least one attachment errored;
 *                 the caller must NOT auto-send (the user may not be
 *                 looking at the composer to notice the failed chip)
 * - "completed" - all uploads finished cleanly, safe to proceed
 */
export async function waitForPendingUploads(
  getAttachments: () => readonly PendingUploadLike[],
  isCancelled: () => boolean,
  pollMs = 150
): Promise<PendingUploadWaitResult> {
  while (getAttachments().some((att) => att.uploading)) {
    if (isCancelled()) return "cancelled";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return getAttachments().some((att) => att.error) ? "failed" : "completed";
}
