"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { X, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getFilePreviewKind } from "@/lib/file-preview";

interface FilePreviewModalProps {
  name: string;
  onClose: () => void;
  onDownload: () => Promise<void> | void;
  getFileContent: () => Promise<{ blob: Blob; contentType: string }>;
}

function SimpleMarkdown({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headers
    if (line.startsWith("### ")) {
      elements.push(<h3 key={i} className="text-lg font-semibold mt-4 mb-2">{processInline(line.slice(4))}</h3>);
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={i} className="text-xl font-semibold mt-5 mb-2">{processInline(line.slice(3))}</h2>);
    } else if (line.startsWith("# ")) {
      elements.push(<h1 key={i} className="text-2xl font-bold mt-6 mb-3">{processInline(line.slice(2))}</h1>);
    } else if (line.startsWith("---") || line.startsWith("***")) {
      elements.push(<hr key={i} className="my-4 border-border" />);
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(<li key={i} className="ml-4 list-disc">{processInline(line.slice(2))}</li>);
    } else if (/^\d+\. /.test(line)) {
      elements.push(<li key={i} className="ml-4 list-decimal">{processInline(line.replace(/^\d+\. /, ""))}</li>);
    } else if (line.startsWith("> ")) {
      elements.push(<blockquote key={i} className="border-l-4 border-border pl-4 italic text-muted-foreground my-2">{processInline(line.slice(2))}</blockquote>);
    } else if (line.startsWith("```")) {
      // Code block - collect until closing ```
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={i} className="bg-muted rounded p-3 my-2 overflow-x-auto text-sm font-mono">
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
    } else if (line.trim() === "") {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(<p key={i} className="my-1">{processInline(line)}</p>);
    }
  }

  return <div className="prose prose-sm dark:prose-invert max-w-none">{elements}</div>;
}

function processInline(text: string): React.ReactNode {
  // Process bold, italic, code inline
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    // Inline code
    const codeMatch = remaining.match(/`([^`]+)`/);
    // Italic
    const italicMatch = remaining.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);

    const matches = [
      boldMatch && { type: "bold", match: boldMatch },
      codeMatch && { type: "code", match: codeMatch },
      italicMatch && { type: "italic", match: italicMatch },
    ].filter(Boolean).sort((a, b) => (a!.match.index ?? 0) - (b!.match.index ?? 0));

    if (matches.length === 0) {
      parts.push(remaining);
      break;
    }

    const first = matches[0]!;
    const idx = first.match.index ?? 0;

    if (idx > 0) {
      parts.push(remaining.slice(0, idx));
    }

    if (first.type === "bold") {
      parts.push(<strong key={key++}>{first.match[1]}</strong>);
    } else if (first.type === "code") {
      parts.push(<code key={key++} className="bg-muted px-1 py-0.5 rounded text-sm font-mono">{first.match[1]}</code>);
    } else {
      parts.push(<em key={key++}>{first.match[1]}</em>);
    }

    remaining = remaining.slice(idx + first.match[0].length);
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

export function FilePreviewModal({ name, onClose, onDownload, getFileContent }: FilePreviewModalProps) {
  const t = useTranslations("files");
  const [content, setContent] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [resolvedFileType, setResolvedFileType] = useState(() => getFilePreviewKind(name));

  const fileType = resolvedFileType;

  useEffect(() => {
    let cancelled = false;
    let revokeUrl: string | null = null;

    setContent(null);
    setObjectUrl(null);
    setLoading(true);
    setError(false);
    setResolvedFileType(getFilePreviewKind(name));

    async function load() {
      try {
        const { blob, contentType } = await getFileContent();

        if (cancelled) return;

        const previewType = getFilePreviewKind(name, contentType || blob.type);
  setResolvedFileType(previewType);

        if (previewType === "text" || previewType === "markdown") {
          const text = await blob.text();
          if (!cancelled) setContent(text);
        } else {
          revokeUrl = URL.createObjectURL(blob);
          if (!cancelled) setObjectUrl(revokeUrl);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
      if (revokeUrl) {
        URL.revokeObjectURL(revokeUrl);
      }
    };
  }, [getFileContent, name]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div role="dialog" aria-label={name} className="fixed inset-0 z-50 flex flex-col bg-black/80" onClick={onClose}>
      <div className="flex items-center justify-between px-4 py-3 bg-background/90 backdrop-blur border-b border-border" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-medium truncate">{name}</h3>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void onDownload()}>
            <Download className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
        {loading && (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin" />
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive">{t("preview_error")}</p>
        )}

        {!loading && !error && (fileType === "text") && content !== null && (
          <pre className="bg-background rounded-lg p-6 max-w-4xl w-full max-h-full overflow-auto text-sm font-mono whitespace-pre-wrap break-words">
            {content}
          </pre>
        )}

        {!loading && !error && fileType === "markdown" && content !== null && (
          <div className="bg-background rounded-lg p-6 max-w-4xl w-full max-h-full overflow-auto text-sm">
            <SimpleMarkdown content={content} />
          </div>
        )}

        {!loading && !error && fileType === "image" && objectUrl && (
          <img
            src={objectUrl}
            alt={name}
            className="max-w-full max-h-full object-contain rounded-lg bg-background"
            draggable={false}
          />
        )}

        {!loading && !error && fileType === "html" && objectUrl && (
          <iframe
            src={objectUrl}
            sandbox=""
            className="w-full max-w-5xl h-full rounded-lg bg-white"
            title={name}
          />
        )}

        {!loading && !error && fileType === "pdf" && objectUrl && (
          <iframe
            src={objectUrl}
            sandbox="allow-scripts"
            className="w-full max-w-5xl h-full rounded-lg bg-white"
            title={name}
          />
        )}

        {!loading && !error && fileType === "audio" && objectUrl && (
          <div className="bg-background rounded-lg p-8 max-w-lg w-full">
            <p className="text-sm font-medium mb-4 text-center">{name}</p>
            <audio controls className="w-full" src={objectUrl} />
          </div>
        )}

        {!loading && !error && fileType === "video" && objectUrl && (
          <video controls className="max-w-4xl max-h-full rounded-lg" src={objectUrl} />
        )}
      </div>
    </div>
  );
}
