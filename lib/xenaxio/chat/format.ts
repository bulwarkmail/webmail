// Step 43, part B: message text. The composer writes Slack-like Markdown
// (**bold**, _italic_, ~~strike~~, `code`, ``` blocks ```, > quotes, lists,
// links, @mentions); it is sent as plain text plus Matrix HTML. Incoming HTML
// is sanitized before it is shown (colleagues' messages are untrusted).
import DOMPurify from "dompurify";

export interface Mention {
  userId: string;
  displayName: string;
}

/** "@channel" and "@here" notify everyone in the channel (Matrix: a room mention). */
export const ROOM_MENTIONS = ["@channel", "@here"] as const;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Inline Markdown of one line, already HTML-escaped (code spans stay untouched). */
function inline(escaped: string, mentions: Mention[]): string {
  const parts = escaped.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${part.slice(1, -1)}</code>`;
      let out = part;
      // Links first, so the markers below do not touch addresses.
      const links: string[] = [];
      out = out.replace(URL_RE, (url) => {
        links.push(`<a href="${url}">${url}</a>`);
        return `\uE000${links.length - 1}\uE001`;
      });
      out = out
        .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1<em>$2</em>")
        .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>")
        .replace(/~~(?=\S)([^~]*?\S)~~/g, "<del>$1</del>");
      for (const m of [...mentions].sort((a, b) => b.displayName.length - a.displayName.length)) {
        const label = escapeHtml(`@${m.displayName}`);
        out = out.split(label).join(`<a href="https://matrix.to/#/${encodeURIComponent(m.userId)}">${label}</a>`);
      }
      return out.replace(/\uE000(\d+)\uE001/g, (_, i) => links[Number(i)] as string);
    })
    .join("");
}

/** Composer text → Matrix HTML (null when the text needs none). */
export function toHtml(text: string, mentions: Mention[] = []): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      const first = line.trim().slice(3);
      if (first.endsWith("```") && first.length > 3) {
        out.push(`<pre><code>${escapeHtml(first.slice(0, -3))}</code></pre>`);
        i++;
        continue;
      }
      if (first) code.push(first);
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith("```")) code.push(lines[i++] as string);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] as string)) quote.push((lines[i++] as string).replace(/^>\s?/, ""));
      out.push(`<blockquote>${quote.map((l) => inline(escapeHtml(l), mentions)).join("<br>")}</blockquote>`);
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i] as string)) items.push((lines[i++] as string).replace(/^\s*[-*•]\s+/, ""));
      out.push(`<ul>${items.map((l) => `<li>${inline(escapeHtml(l), mentions)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] as string)) items.push((lines[i++] as string).replace(/^\s*\d+[.)]\s+/, ""));
      out.push(`<ol>${items.map((l) => `<li>${inline(escapeHtml(l), mentions)}</li>`).join("")}</ol>`);
      continue;
    }
    out.push(inline(escapeHtml(line), mentions));
    i++;
  }
  // Join plain lines with <br>, but not around block elements.
  let html = "";
  out.forEach((part, idx) => {
    const block = /^<(pre|blockquote|ul|ol)>/.test(part);
    const prevBlock = idx > 0 && /^<(pre|blockquote|ul|ol)>/.test(out[idx - 1] as string);
    if (idx > 0 && !block && !prevBlock) html += "<br>";
    html += part;
  });
  return html === escapeHtml(text).replace(/\n/g, "<br>") ? null : html;
}

/** The content of a text message from the composer. */
export function textContent(text: string, mentions: Mention[] = []): Record<string, unknown> {
  const body = text.trim();
  const used = mentions.filter((m) => body.includes(`@${m.displayName}`));
  const room = ROOM_MENTIONS.some((m) => new RegExp(`(^|\\s)${m}\\b`).test(body));
  const html = toHtml(body, used);
  return {
    msgtype: "m.text",
    body,
    ...(html ? { format: "org.matrix.custom.html", formatted_body: html } : {}),
    "m.mentions": { ...(used.length ? { user_ids: [...new Set(used.map((m) => m.userId))] } : {}), ...(room ? { room: true } : {}) },
  };
}

/** HTML elements and attributes a chat message may use (Matrix spec, without images and colours). */
const ALLOWED_TAGS = ["a", "b", "strong", "i", "em", "u", "del", "s", "strike", "code", "pre", "blockquote", "p", "br", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "span", "sup", "sub", "hr", "table", "thead", "tbody", "tr", "th", "td"];

let hooked = false;
function purifier() {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        const href = node.getAttribute("href") ?? "";
        const target = /^https:\/\/matrix\.to\/#\/([^/?]+)/.exec(href);
        let user: string | null = null;
        try {
          user = target ? decodeURIComponent(target[1] as string) : null;
        } catch {
          user = null;
        }
        if (user?.startsWith("@")) {
          node.setAttribute("data-mention", user);
          node.removeAttribute("href");
          node.setAttribute("class", "chat-mention");
          return;
        }
        if (!/^(https?:|mailto:)/i.test(href)) node.removeAttribute("href");
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      }
    });
  }
  return DOMPurify;
}

function linkify(escaped: string): string {
  return escaped.replace(URL_RE, (url) => `<a href="${url}">${url}</a>`);
}

/**
 * Safe HTML of a message for display. Mentions become `<a data-mention>`;
 * the interface styles them and shows names.
 */
export function messageHtml(content: Record<string, unknown>): string {
  const body = typeof content.body === "string" ? content.body : "";
  const raw = content.format === "org.matrix.custom.html" && typeof content.formatted_body === "string" ? content.formatted_body : linkify(escapeHtml(body)).replace(/\n/g, "<br>");
  // Thread fallbacks quote the replied-to message; Matrix marks them for removal.
  const withoutFallback = raw.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/g, "");
  return purifier().sanitize(withoutFallback, { ALLOWED_TAGS, ALLOWED_ATTR: ["href", "target", "rel", "data-mention", "class"], ALLOW_DATA_ATTR: false }) as string;
}

/** Does the message mention this person (or everyone)? */
export function mentionsUser(content: Record<string, unknown>, userId: string): boolean {
  const m = content["m.mentions"] as { user_ids?: string[]; room?: boolean } | undefined;
  return !!m && (m.room === true || (m.user_ids ?? []).includes(userId));
}

/** One line of text for previews, search results and notifications. */
export function plainPreview(content: Record<string, unknown>, max = 140): string {
  const type = content.msgtype;
  const body = typeof content.body === "string" ? content.body : "";
  const prefix = type === "m.image" ? "🖼 " : type === "m.file" ? "📎 " : type === "m.video" ? "🎬 " : type === "m.audio" ? "🎵 " : "";
  const text = body.replace(/\s+/g, " ").trim();
  return prefix + (text.length > max ? `${text.slice(0, max - 1)}…` : text);
}
