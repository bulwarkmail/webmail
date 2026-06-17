import type { Email } from "@/lib/jmap/types";

// Allow any Unicode letter or digit (so umlauts, accents, CJK survive) plus a
// small set of safe punctuation. Everything else - emojis, RTL/zero-width
// marks, control chars, and the filesystem-reserved `<>:"/\|?*` - collapses
// to `_`. Keeps filenames usable across Windows/macOS/Linux without flattening
// non-ASCII scripts.
const SAFE_CHARS = /[^\p{L}\p{N} _\-().,!@#&+=[\]{}']/gu;

export type SpaceReplacement = "keep" | "underscore" | "dash";

export interface FilenameTransformOptions {
  spaceReplacement?: SpaceReplacement;
  lowercase?: boolean;
  stripDiacritics?: boolean;
  collapseSeparators?: boolean;
}

export interface EmailFilenameOptions extends FilenameTransformOptions {
  template?: string;
}

export const DEFAULT_TRANSFORM: Required<FilenameTransformOptions> = {
  spaceReplacement: "keep",
  lowercase: false,
  stripDiacritics: false,
  collapseSeparators: true,
};

export const DEFAULT_EMAIL_TEMPLATE = "{date} ({from}-{to}) {subject}";
export const DEFAULT_ATTACHMENT_TEMPLATE = "{filename}";
export const DEFAULT_BUNDLE_TEMPLATE = "emails-{count}";

export const EMAIL_TOKENS: { token: string; description: string }[] = [
  { token: "date", description: "Full date and time, e.g. 2026-05-22 14.05.33" },
  { token: "date_short", description: "Date only, e.g. 2026-05-22" },
  { token: "time", description: "Time only, e.g. 14.05.33" },
  { token: "year", description: "4-digit year" },
  { token: "month", description: "2-digit month" },
  { token: "day", description: "2-digit day" },
  { token: "from", description: "Sender display name (falls back to email user part)" },
  { token: "from_email", description: "Sender full email address" },
  { token: "from_name", description: "Sender name only" },
  { token: "to", description: "First recipient display name" },
  { token: "to_email", description: "First recipient full email address" },
  { token: "to_name", description: "First recipient name only" },
  { token: "subject", description: "Email subject" },
];

export const ATTACHMENT_TOKENS: { token: string; description: string }[] = [
  ...EMAIL_TOKENS,
  { token: "filename", description: "Original attachment filename including extension" },
  { token: "name", description: "Attachment filename without extension" },
  { token: "ext", description: "Attachment file extension without leading dot" },
];

export const BUNDLE_TOKENS: { token: string; description: string }[] = [
  { token: "count", description: "Number of emails in the bundle" },
  { token: "date", description: "Current date and time, e.g. 2026-05-22 14.05.33" },
  { token: "date_short", description: "Current date, e.g. 2026-05-22" },
  { token: "time", description: "Current time, e.g. 14.05.33" },
  { token: "year", description: "4-digit year" },
  { token: "month", description: "2-digit month" },
  { token: "day", description: "2-digit day" },
];

// Overall cap for a generated filename stem. Also used as the per-token cap so
// a single long token (e.g. {subject}) isn't truncated earlier than the final
// filename would be.
const FILENAME_MAX_LEN = 200;

function sanitizePart(input: string, maxLen = 80): string {
  const cleaned = input
    .replace(SAFE_CHARS, "_")
    .replace(/_+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[._-]+|[._-]+$/g, "");
  return cleaned.slice(0, maxLen);
}

function applyTransforms(input: string, opts: FilenameTransformOptions): string {
  let s = input;
  if (opts.stripDiacritics) {
    // NFD splits "ä" into "a" + U+0308 (combining diaeresis); stripping all
    // combining marks then leaves plain ASCII letters. `ß` has no
    // decomposition so it survives as-is.
    s = s.normalize("NFD").replace(/\p{M}+/gu, "");
  }
  const repl = opts.spaceReplacement ?? "keep";
  if (repl === "underscore") s = s.replace(/ +/g, "_");
  else if (repl === "dash") s = s.replace(/ +/g, "-");
  if (opts.collapseSeparators ?? true) {
    s = s.replace(/_+/g, "_").replace(/-+/g, "-").replace(/ +/g, " ");
  }
  if (opts.lowercase) s = s.toLocaleLowerCase();
  return s.replace(/^[._\- ]+|[._\- ]+$/g, "");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dateParts(iso: string | null | undefined) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) {
    return {
      date: "0000-00-00 00.00.00",
      date_short: "0000-00-00",
      time: "00.00.00",
      year: "0000",
      month: "00",
      day: "00",
    };
  }
  const year = String(d.getFullYear());
  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const time = `${pad2(d.getHours())}.${pad2(d.getMinutes())}.${pad2(d.getSeconds())}`;
  return {
    date: `${year}-${month}-${day} ${time}`,
    date_short: `${year}-${month}-${day}`,
    time,
    year,
    month,
    day,
  };
}

function addrLabel(addr: { name?: string | null; email: string } | undefined): {
  name: string;
  email: string;
  label: string;
} {
  if (!addr) return { name: "", email: "", label: "unknown" };
  const name = (addr.name && addr.name.trim()) || "";
  const email = addr.email || "";
  const label = name || email.split("@")[0] || email || "unknown";
  return { name, email, label };
}

export function emailVars(email: Email): Record<string, string> {
  const dp = dateParts(email.receivedAt || email.sentAt);
  const from = addrLabel(email.from?.[0]);
  const to = addrLabel(email.to?.[0]);
  return {
    ...dp,
    from: from.label,
    from_email: from.email,
    from_name: from.name,
    to: to.label,
    to_email: to.email,
    to_name: to.name,
    subject: email.subject || "no subject",
  };
}

export interface AttachmentLike {
  name?: string | null;
  type?: string | null;
}

export function attachmentVars(email: Email, attachment: AttachmentLike): Record<string, string> {
  const filename = (attachment.name || "attachment").trim();
  const dot = filename.lastIndexOf(".");
  const hasExt = dot > 0 && dot < filename.length - 1;
  const name = hasExt ? filename.slice(0, dot) : filename;
  const ext = hasExt ? filename.slice(dot + 1) : "";
  return {
    ...emailVars(email),
    filename,
    name,
    ext,
  };
}

function renderRaw(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) return "";
    return sanitizePart(value, FILENAME_MAX_LEN);
  });
}

export function emailExportFilename(
  email: Email,
  options: EmailFilenameOptions | string = {},
): string {
  const opts = typeof options === "string" ? { template: options } : options;
  const template = opts.template ?? DEFAULT_EMAIL_TEMPLATE;
  const rendered = renderRaw(template, emailVars(email));
  const cleaned = sanitizePart(rendered, FILENAME_MAX_LEN);
  const transformed = applyTransforms(cleaned, opts);
  const stem = transformed.slice(0, FILENAME_MAX_LEN) || "email";
  return `${stem}.eml`;
}

export function attachmentDownloadFilename(
  email: Email | null | undefined,
  attachment: AttachmentLike,
  options: EmailFilenameOptions | string = {},
): string {
  const opts = typeof options === "string" ? { template: options } : options;
  const template = opts.template ?? DEFAULT_ATTACHMENT_TEMPLATE;
  if (!email) {
    const filename = (attachment.name || "attachment").trim();
    const cleaned = sanitizePart(filename, FILENAME_MAX_LEN) || "attachment";
    return applyTransforms(cleaned, opts) || cleaned;
  }
  const vars = attachmentVars(email, attachment);
  const rendered = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) return "";
    // Preserve dots in {filename} so the original extension survives the
    // sanitiser (it strips trailing dots otherwise).
    return key === "filename" ? value.replace(SAFE_CHARS, "_") : sanitizePart(value, FILENAME_MAX_LEN);
  });
  const templateMentionsExt = /\{(ext|filename)\}/.test(template);
  const cleaned = sanitizePart(rendered, FILENAME_MAX_LEN) || "attachment";
  if (templateMentionsExt) {
    return applyTransforms(cleaned, opts) || cleaned;
  }
  const transformedStem = applyTransforms(cleaned, opts) || cleaned;
  const ext = vars.ext;
  if (!ext) return transformedStem;
  const transformedExt = opts.lowercase ? ext.toLocaleLowerCase() : ext;
  return `${transformedStem}.${transformedExt}`;
}

export function bundleVars(count: number, iso?: string): Record<string, string> {
  const dp = dateParts(iso ?? new Date().toISOString());
  return { ...dp, count: String(count) };
}

export function bundleExportFilename(
  count: number,
  options: EmailFilenameOptions | string = {},
  iso?: string,
): string {
  const opts = typeof options === "string" ? { template: options } : options;
  const template = opts.template ?? DEFAULT_BUNDLE_TEMPLATE;
  const rendered = renderRaw(template, bundleVars(count, iso));
  const cleaned = sanitizePart(rendered, FILENAME_MAX_LEN);
  const transformed = applyTransforms(cleaned, opts);
  const stem = transformed.slice(0, FILENAME_MAX_LEN) || "emails";
  return `${stem}.zip`;
}

// Build a synthetic email for previewing templates in the settings UI.
export function buildSampleEmail(): Email {
  // Use a fixed date so the preview doesn't churn as the user types.
  const iso = "2026-05-22T14:05:33Z";
  return {
    id: "sample-1",
    threadId: "sample-thread-1",
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    size: 12345,
    receivedAt: iso,
    sentAt: iso,
    from: [{ name: "Alice Sender", email: "alice@example.com" }],
    to: [{ name: "Bob Recipient", email: "bob@example.com" }],
    cc: [],
    subject: "Benachrichtigung von Ihrem Gerät",
    preview: "",
    hasAttachment: true,
    blobId: "sample-blob",
  };
}
