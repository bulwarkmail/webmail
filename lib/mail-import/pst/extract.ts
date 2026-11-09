import type { MailAddress, PstAttachmentData, PstMailData } from "./mime";

/**
 * Reads folders and messages out of a pst-extractor PSTFile. Typed loosely
 * on purpose: the objects come from the library inside the worker, and the
 * protected property getters used here (getIntItem, getStringItem) are plain
 * methods at run time.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type PstObject = any;

/** Folders under the root that hold no mail of the user's own (search results, views, system data). */
const SYSTEM_FOLDERS = new Set([
  "search root", "spam search folder 2", "ipm_views", "ipm_common_views", "reminders", "to-do search",
  "itemprocsearch", "tracked mail processing", "freebusy data", "finder", "common views", "views",
  "shortcuts", "schedule", "deferred action", "spooler queue", "conversation action settings",
]);

/** Containers whose name is no folder of the user's: their contents go to the top. */
const ROOT_NAMES = new Set(["top of personal folders", "top of outlook data file", "root - mailbox", "ipm_subtree", "root - public"]);

const PR_IPM_SUBTREE_ENTRYID = 0x35e0;
const PR_IPM_WASTEBASKET_ENTRYID = 0x35e3;
const PR_IPM_SENTMAIL_ENTRYID = 0x35e4;
const PR_IPM_DRAFTS_ENTRYID = 0x36d7;
const PR_FLAG_STATUS = 0x1090;
const PR_SENDER_SMTP_ADDRESS = 0x5d01;
const PR_SENT_REPRESENTING_SMTP_ADDRESS = 0x5d02;
const ATTACH_EMBEDDED_MSG = 5;

export type ItemKind = "mail" | "contact" | "calendar" | "other";

/** What kind of item a message class is. */
export function itemKind(messageClass: string): ItemKind {
  const c = (messageClass || "IPM.Note").toLowerCase();
  if (c === "ipm" || c === "ipm.note" || c.startsWith("ipm.note.") || c === "ipm.post" || c.startsWith("report.ipm.note")) return "mail";
  if (c.startsWith("ipm.contact") || c.startsWith("ipm.distlist")) return "contact";
  if (c.startsWith("ipm.appointment") || c.startsWith("ipm.schedule") || c.startsWith("ipm.task") || c.startsWith("ipm.microsoft.scheduledata")) return "calendar";
  return "other";
}

/** Whether a folder holds mail (not a calendar, contacts, tasks, notes or journal folder). */
function isMailFolder(folder: PstObject): boolean {
  const cls = String(folder.containerClass || "").toLowerCase();
  return cls === "" || cls === "ipf" || cls.startsWith("ipf.note");
}

export interface PstFolderRef {
  folder: PstObject;
  path: string[];
  /** What the PST says the top folder of `path` is (sent, trash, drafts), whatever its name in the user's language. */
  topRole?: string;
  /** A calendar, contacts or other non-mail folder: its items are counted, not imported. */
  mail: boolean;
}

/**
 * The folders to read, depth first, under the mailbox's top (the IPM
 * subtree): PSTs name it in the message store, OSTs call it IPM_SUBTREE.
 */
export function* pstFolders(pst: PstObject): Generator<PstFolderRef> {
  const root = pst.getRootFolder();
  let top: PstObject = null;
  try {
    const entry = pst.getMessageStore().getBinaryItem?.(PR_IPM_SUBTREE_ENTRYID);
    const nid = entry && entry.length >= 24 ? entry.readUInt32LE(20) : null;
    if (nid !== null) {
      const find = (folder: PstObject, depth: number): PstObject => {
        if (Number(folder.descriptorNodeId) === nid || folder.descriptorNodeId?.toNumber?.() === nid) return folder;
        if (depth >= 3 || !folder.hasSubfolders) return null;
        for (const child of folder.getSubFolders()) {
          const hit = find(child, depth + 1);
          if (hit) return hit;
        }
        return null;
      };
      top = find(root, 0);
    }
  } catch {
    top = null;
  }

  // Special folders by their entry IDs: the message store names Sent Items and
  // Deleted Items, the top folder names Drafts. The Inbox is found by name.
  const roles = new Map<number, string>();
  const nidOf = (entry: { length: number; readUInt32LE(at: number): number } | null | undefined) =>
    entry && entry.length >= 24 ? entry.readUInt32LE(20) : null;
  try {
    const store = pst.getMessageStore();
    for (const [id, role] of [[PR_IPM_SENTMAIL_ENTRYID, "sent"], [PR_IPM_WASTEBASKET_ENTRYID, "trash"]] as const) {
      const nid = nidOf(store.getBinaryItem?.(id));
      if (nid !== null) roles.set(nid, role);
    }
    const drafts = nidOf((top ?? root).getBinaryItem?.(PR_IPM_DRAFTS_ENTRYID));
    if (drafts !== null) roles.set(drafts, "drafts");
  } catch {
    /* names are the fallback */
  }
  const nidOfFolder = (folder: PstObject): number => Number(folder.descriptorNodeId?.toNumber?.() ?? folder.descriptorNodeId);

  function* walk(folder: PstObject, path: string[], depth: number, topRole?: string): Generator<PstFolderRef> {
    if (!folder.hasSubfolders) return;
    for (const child of folder.getSubFolders()) {
      const name = String(child.displayName || "").trim();
      const lower = name.toLowerCase();
      // Outside the IPM subtree only what sits next to the mailbox's top counts as system data.
      if (!top && path.length === 0 && SYSTEM_FOLDERS.has(lower)) continue;
      const childPath = !top && ROOT_NAMES.has(lower) && path.length === 0 ? path : [...path, name || "Folder"];
      const role = childPath.length === 1 && path.length === 0 ? roles.get(nidOfFolder(child)) : topRole;
      yield { folder: child, path: childPath, mail: isMailFolder(child), topRole: role };
      yield* walk(child, childPath, depth + 1, role);
    }
  }

  if (top) {
    yield { folder: top, path: [], mail: true };
    yield* walk(top, [], 1);
  } else {
    yield { folder: root, path: [], mail: true };
    yield* walk(root, [], 0);
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+$/.test(value);
}

function senderOf(m: PstObject): MailAddress | undefined {
  const name = str(m.senderName) || str(m.sentRepresentingName);
  const candidates = [
    str(m.senderAddrtype).toUpperCase() === "SMTP" ? str(m.senderEmailAddress) : "",
    safeString(m, PR_SENDER_SMTP_ADDRESS),
    str(m.sentRepresentingAddressType).toUpperCase() === "SMTP" ? str(m.sentRepresentingEmailAddress) : "",
    safeString(m, PR_SENT_REPRESENTING_SMTP_ADDRESS),
    str(m.senderEmailAddress),
  ];
  const email = candidates.find(looksLikeEmail);
  return email ? { name, email } : undefined;
}

function safeString(m: PstObject, id: number): string {
  try {
    return str(m.getStringItem?.(id));
  } catch {
    return "";
  }
}

function safeInt(m: PstObject, id: number): number | undefined {
  try {
    const v = m.getIntItem?.(id);
    return typeof v === "number" ? v : undefined;
  } catch {
    return undefined;
  }
}

function recipients(m: PstObject): { to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[] } {
  const out = { to: [] as MailAddress[], cc: [] as MailAddress[], bcc: [] as MailAddress[] };
  const count = Number(m.numberOfRecipients) || 0;
  for (let i = 0; i < count; i++) {
    let r: PstObject;
    try { r = m.getRecipient(i); } catch { continue; }
    if (!r) continue;
    const email = [str(r.smtpAddress), str(r.emailAddress)].find(looksLikeEmail);
    if (!email) continue;
    const entry = { name: str(r.displayName), email };
    if (r.recipientType === 2) out.cc.push(entry);
    else if (r.recipientType === 3) out.bcc.push(entry);
    else out.to.push(entry);
  }
  return out;
}

const EXT_TYPES: Record<string, string> = {
  txt: "text/plain", htm: "text/html", html: "text/html", pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg",
  png: "image/png", gif: "image/gif", bmp: "image/bmp", zip: "application/zip", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ics: "text/calendar", vcf: "text/vcard",
  eml: "message/rfc822", msg: "application/vnd.ms-outlook", csv: "text/csv", rtf: "application/rtf",
};

function mimeTypeFor(tag: string, filename: string): string {
  const t = tag.trim().toLowerCase();
  if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(t)) return t;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TYPES[ext] ?? "application/octet-stream";
}

export interface PstMessage {
  mail: PstMailData;
  keywords: Record<string, true>;
  receivedAt?: Date;
  /** Attached messages pst-extractor can't read. */
  embedded: number;
  /** Bigger than the server takes: nothing was read in. */
  tooLarge?: boolean;
}

function streamLength(stream: PstObject): number {
  return typeof stream?.length === "number" ? stream.length : Number(stream?.length?.toNumber?.() ?? 0);
}

/**
 * A mail item's properties, its attachments read in, as data for buildMime.
 * A message whose attachments alone would be bigger than `maxBytes` once in
 * base64 is reported `tooLarge` before anything is read: a 1 GB attachment
 * would take several GB in the worker.
 */
export function readPstMessage(m: PstObject, maxBytes = Number.POSITIVE_INFINITY): PstMessage {
  const attachments: PstAttachmentData[] = [];
  let embedded = 0;
  const count = Number(m.numberOfAttachments) || 0;
  if (Number.isFinite(maxBytes)) {
    let declared = 0;
    for (let i = 0; i < count; i++) {
      try {
        const a = m.getAttachment(i);
        if (a && a.attachMethod !== ATTACH_EMBEDDED_MSG) declared += streamLength(a.fileInputStream);
      } catch {
        /* read below, or skipped there */
      }
    }
    if (Math.ceil(declared / 3) * 4 > maxBytes) {
      return { mail: { subject: str(m.subject), to: [], cc: [], bcc: [], attachments: [] }, keywords: {}, embedded: 0, tooLarge: true };
    }
  }
  for (let i = 0; i < count; i++) {
    let a: PstObject;
    try { a = m.getAttachment(i); } catch { continue; }
    if (!a) continue;
    if (a.attachMethod === ATTACH_EMBEDDED_MSG) { embedded++; continue; }
    const stream = a.fileInputStream;
    if (!stream) continue;
    const length = streamLength(stream);
    const buffer = new Uint8Array(length);
    try {
      // pst-extractor wants a Buffer; one over our bytes fills them in place.
      const B = (globalThis as { Buffer?: { from(b: ArrayBuffer, o: number, l: number): Uint8Array } }).Buffer;
      stream.readCompletely(B ? B.from(buffer.buffer, buffer.byteOffset, buffer.byteLength) : buffer);
    } catch {
      continue;
    }
    const filename = str(a.longFilename) || str(a.filename) || `attachment-${i + 1}`;
    attachments.push({ filename, mimeType: mimeTypeFor(str(a.mimeTag), filename), contentId: str(a.contentId) || undefined, data: buffer });
  }

  const { to, cc, bcc } = recipients(m);
  const submitted: Date | null = m.clientSubmitTime ?? null;
  const delivered: Date | null = m.messageDeliveryTime ?? null;
  const verb = Number(m.lastVerbExecuted) || 0;
  const keywords: Record<string, true> = {};
  if (m.isRead) keywords.$seen = true;
  if (safeInt(m, PR_FLAG_STATUS) === 2) keywords.$flagged = true;
  if (verb === 102 || verb === 103) keywords.$answered = true;
  if (verb === 104) keywords.$forwarded = true;
  if (m.isUnsent) keywords.$draft = true;

  let rtf = "";
  let text = str(m.body);
  let html = str(m.bodyHTML);
  if (!html && !text.trim()) {
    try { rtf = str(m.bodyRTF); } catch { rtf = ""; }
  }
  if (!text.trim() && !html && !rtf) text = "";

  return {
    mail: {
      headers: str(m.transportMessageHeaders) || undefined,
      subject: str(m.subject),
      from: senderOf(m),
      to, cc, bcc,
      date: submitted ?? delivered ?? undefined,
      messageId: str(m.internetMessageId) || undefined,
      inReplyTo: str(m.inReplyToId) || undefined,
      importance: typeof m.importance === "number" ? m.importance : undefined,
      text, html: html || undefined, rtf: rtf || undefined,
      attachments,
    },
    keywords,
    receivedAt: delivered ?? submitted ?? undefined,
    embedded,
  };
}
