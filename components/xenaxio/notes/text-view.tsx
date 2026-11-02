"use client";

// Xenaxio step 115, part 2: a text file as it reads, by its kind. Markdown as
// on GitHub, CSV as a table, JSON formatted (or where it is broken), HTML as a
// page in a locked frame, code highlighted, the rest as text. Links are
// clickable everywhere.
import { useMemo, type ReactNode } from "react";
import { AlertTriangle } from "@/components/icons";
import { MarkdownView } from "@/components/xenaxio/markdown-view";
import { useHighlighter } from "@/components/xenaxio/chat/code";
import { htmlAttachmentDocument } from "@/components/files/file-preview-modal";
import { highlight } from "@/lib/xenaxio/chat/snippet";
import { useXT } from "@/lib/xenaxio/i18n";
import { checkJson, codeLanguageOf, csvSeparator, linkifyHtml, parseCsv, splitLinks, textKindOf } from "@/lib/xenaxio/text-files";
import "@/components/xenaxio/chat/code.css";

/** A table this long is enough to read; the rest is in "Bearbeiten" or the download. */
const CSV_MAX_ROWS = 2000;

const LINK = "text-primary underline-offset-2 hover:underline";

export function TextFileView({ name, text }: { name: string; text: string }) {
  const kind = textKindOf(name);
  if (kind === "markdown") return <MarkdownView source={text} />;
  if (kind === "csv") return <CsvView name={name} text={text} />;
  if (kind === "json") return <JsonView text={text} />;
  if (kind === "html") return <HtmlView name={name} text={text} />;
  if (kind === "code") return <CodeView code={text} language={codeLanguageOf(name)} />;
  return <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed"><Linked text={text} /></pre>;
}

/** Plain text with its http(s) addresses as links. */
export function Linked({ text }: { text: string }) {
  const parts = useMemo(() => splitLinks(text), [text]);
  return (
    <>
      {parts.map((p, i): ReactNode =>
        p.href ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow" className={LINK}>{p.text}</a>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

function CodeView({ code, language }: { code: string; language: string | null }) {
  const hljs = useHighlighter(!!language);
  const html = useMemo(() => (hljs && language ? linkifyHtml(highlight(hljs, code, language)) : null), [hljs, code, language]);
  return (
    <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-[0.85em] leading-relaxed [&_a]:underline [&_a]:underline-offset-2">
      {html !== null ? (
        <code className="xen-code block whitespace-pre" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code className="block whitespace-pre"><Linked text={code} /></code>
      )}
    </pre>
  );
}

function JsonView({ text }: { text: string }) {
  const t = useXT();
  const check = useMemo(() => checkJson(text), [text]);
  if (check.ok) return <CodeView code={check.pretty} language="json" />;
  return (
    <div className="space-y-3">
      <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
        <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0 text-amber-600" />
        <span>{check.line ? t("notes.json_broken_line", { line: check.line }) : t("notes.json_broken")}</span>
      </p>
      <CodeView code={text} language="json" />
    </div>
  );
}

function CsvView({ name, text }: { name: string; text: string }) {
  const t = useXT();
  const rows = useMemo(() => parseCsv(text, csvSeparator(text, name)), [name, text]);
  if (rows.length === 0) return null;
  const [head, ...body] = rows;
  const shown = body.slice(0, CSV_MAX_ROWS);
  return (
    <div className="space-y-2">
      <div className="max-w-full overflow-x-auto">
        <table className="border-collapse text-sm">
          <thead>
            <tr>
              {head.map((cell, i) => (
                <th key={i} className="border border-border bg-muted/50 px-3 py-1.5 text-left font-semibold whitespace-nowrap"><Linked text={cell} /></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r}>
                {row.map((cell, i) => (
                  <td key={i} className="border border-border px-3 py-1.5 align-top whitespace-pre-wrap"><Linked text={cell} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {body.length > shown.length && (
        <p className="text-xs text-muted-foreground">{t("notes.csv_more", { shown: shown.length, total: body.length })}</p>
      )}
    </div>
  );
}

/**
 * The page as a mail's HTML attachment is shown: sanitized, no scripts, no
 * pictures by address. Links open in a new tab (the frame may open popups,
 * which leave the sandbox; it gets no scripts and no origin of its own).
 */
function HtmlView({ name, text }: { name: string; text: string }) {
  const doc = useMemo(() => htmlAttachmentDocument(text, true).replace("<head>", '<head><base target="_blank">'), [text]);
  return (
    <iframe
      srcDoc={doc}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      className="h-[70vh] w-full rounded-md border border-border bg-white"
      title={name}
    />
  );
}
