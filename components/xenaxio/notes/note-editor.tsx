"use client";

// Xenaxio step 115: a note (.md, .txt) edited like on GitHub - "Schreiben"
// with Markdown buttons, "Vorschau" as GitHub shows it. Saved on Ctrl+S, by
// the button, two seconds after typing stops and on closing. A save never
// overwrites a version someone else saved meanwhile: the user keeps their text
// as a copy or reloads.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Bold, Code, Heading1, Heading2, Italic, Link, List, ListOrdered, ListTodo, Loader2, Lock, Quote, Save, Strikethrough, X, AlertTriangle,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextFileView } from "@/components/xenaxio/notes/text-view";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useXT } from "@/lib/xenaxio/i18n";
import {
  continueList, copyName, insertLink, isMarkdownName, toggleInline, toggleLines,
  type InlineMark, type LineMark, type SaveState, type TextEdit,
} from "@/lib/xenaxio/notes";
import { textContentType } from "@/lib/xenaxio/text-files";
import { useFileStore, type FileResource } from "@/stores/file-store";
import { toast } from "@/stores/toast-store";
import { cn } from "@/lib/utils";

const AUTOSAVE_MS = 2000;

interface NoteEditorProps {
  resource: FileResource;
  onClose: () => void;
  /** After "save as copy": the editor continues with the copy. */
  onOpenOther: (name: string) => void;
}

type Tab = "view" | "edit";
type Problem = "conflict" | "gone" | null;

export function NoteEditor({ resource, onClose, onOpenOther }: NoteEditorProps) {
  const t = useXT();
  const markdown = isMarkdownName(resource.name);
  const readOnly = resource.myRights?.mayModifyContent === false;

  const [loaded, setLoaded] = useState<"loading" | "ready" | "failed">("loading");
  const [text, setText] = useState("");
  const [tab, setTab] = useState<Tab>("view");
  const [state, setState] = useState<SaveState>("saved");
  const [problem, setProblem] = useState<Problem>(null);
  const [askDiscard, setAskDiscard] = useState(false);
  // After "keep editing" on a conflict, only a manual save tries again.
  const [autosaveOff, setAutosaveOff] = useState(false);

  // What the server holds: the text last saved and its blob. A save sends the
  // blob it expects, so a version saved elsewhere meanwhile is noticed.
  const savedText = useRef("");
  const blobId = useRef<string | null>(resource.blobId);
  const saving = useRef<Promise<boolean> | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);

  // ---- Loading ---------------------------------------------------------------
  const load = useCallback(async (name: string) => {
    setLoaded("loading");
    try {
      const { blob } = await useFileStore.getState().getFileContent(name);
      const content = await blob.text();
      const fresh = useFileStore.getState().resources.find((r) => r.name === name);
      blobId.current = fresh?.blobId ?? blobId.current;
      savedText.current = content;
      setText(content);
      setState("saved");
      setAutosaveOff(false);
      // A file opens as it reads (owner 01.11.2026: "лучше просмотр"); an
      // empty one, like a new note, ready for typing.
      setTab(readOnly || content.trim() !== "" ? "view" : "edit");
      setLoaded("ready");
    } catch (err) {
      console.error("Failed to load the note:", err);
      setLoaded("failed");
    }
  }, [readOnly]);

  useEffect(() => {
    void load(resource.name);
    // Only when another file is opened; a save keeps the editor as it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.id]);

  // ---- Saving ----------------------------------------------------------------
  const save = useCallback(async (): Promise<boolean> => {
    if (readOnly || loaded !== "ready") return true;
    if (saving.current) {
      // One save at a time; changes typed meanwhile go in the next one.
      await saving.current;
      if (textRef.current === savedText.current) return true;
    }
    const content = textRef.current;
    if (content === savedText.current) {
      setState("saved");
      return true;
    }
    const client = useFileStore.getState().client;
    if (!client) return false;
    const run = (async () => {
      setState("saving");
      try {
        const file = new File([content], resource.name, { type: textContentType(resource.name) });
        const result = await client.replaceFileNodeContent(resource.id, file, blobId.current);
        if (result === "conflict" || result === "gone") {
          setProblem(result);
          setState("conflict");
          return false;
        }
        blobId.current = result.blobId;
        savedText.current = content;
        setState(textRef.current === content ? "saved" : "dirty");
        return true;
      } catch (err) {
        console.error("Failed to save the note:", err);
        setState("failed");
        return false;
      }
    })();
    saving.current = run;
    try {
      return await run;
    } finally {
      saving.current = null;
    }
  }, [loaded, readOnly, resource.id, resource.name]);

  // Two seconds after typing stops. Not while a conflict waits for the user.
  useEffect(() => {
    if (loaded !== "ready" || readOnly || problem || autosaveOff) return;
    if (text === savedText.current) return;
    setState((s) => (s === "saving" ? s : "dirty"));
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [text, loaded, readOnly, problem, autosaveOff, save]);

  // Leaving the page with changes not saved yet: the browser asks.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (textRef.current !== savedText.current && !readOnly) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [readOnly]);

  const close = useCallback(async () => {
    if (readOnly || loaded !== "ready" || textRef.current === savedText.current) {
      onClose();
      return;
    }
    if (problem) {
      setAskDiscard(true);
      return;
    }
    if (await save()) onClose();
    else setAskDiscard(true);
  }, [loaded, onClose, problem, readOnly, save]);

  // ---- Conflict --------------------------------------------------------------
  const saveAsCopy = useCallback(async () => {
    const store = useFileStore.getState();
    const before = new Set(store.resources.map((r) => r.name));
    const wanted = copyName(resource.name, t("notes.copy_suffix"));
    try {
      setState("saving");
      await store.uploadFile(new File([textRef.current], wanted, { type: textContentType(wanted) }));
      await store.refresh();
      const made = useFileStore.getState().resources.find((r) => !before.has(r.name) && !r.isDirectory)?.name ?? wanted;
      savedText.current = textRef.current;
      setProblem(null);
      setAutosaveOff(false);
      toast.success(t("notes.saved_as_copy", { name: made }));
      onOpenOther(made);
    } catch (err) {
      console.error("Failed to save the copy:", err);
      setState("failed");
      toast.error(t("notes.save_failed"));
    }
  }, [onOpenOther, resource.name, t]);

  const reload = useCallback(async () => {
    setProblem(null);
    await useFileStore.getState().refresh();
    const fresh = useFileStore.getState().resources.find((r) => r.name === resource.name);
    if (!fresh) {
      toast.error(t("notes.gone"));
      onClose();
      return;
    }
    blobId.current = fresh.blobId;
    await load(resource.name);
  }, [load, onClose, resource.name, t]);

  // ---- Editing ---------------------------------------------------------------
  /**
   * Puts an edit into the field. The change goes in as typed text, so the
   * browser's undo (Ctrl+Z) takes it back; where that is not supported, the
   * text is set directly.
   */
  const apply = useCallback((edit: TextEdit) => {
    const area = areaRef.current;
    const old = textRef.current;
    if (area) {
      let head = 0;
      while (head < old.length && head < edit.text.length && old[head] === edit.text[head]) head++;
      let tail = 0;
      while (tail < old.length - head && tail < edit.text.length - head && old[old.length - 1 - tail] === edit.text[edit.text.length - 1 - tail]) tail++;
      area.focus();
      area.setSelectionRange(head, old.length - tail);
      const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, edit.text.slice(head, edit.text.length - tail));
      if (inserted && area.value === edit.text) {
        area.setSelectionRange(edit.start, edit.end);
        return;
      }
    }
    pendingSelection.current = { start: edit.start, end: edit.end };
    setText(edit.text);
  }, []);

  useEffect(() => {
    const sel = pendingSelection.current;
    const area = areaRef.current;
    if (!sel || !area) return;
    pendingSelection.current = null;
    area.focus();
    area.setSelectionRange(sel.start, sel.end);
  }, [text]);

  const selection = () => {
    const area = areaRef.current;
    return { start: area?.selectionStart ?? textRef.current.length, end: area?.selectionEnd ?? textRef.current.length };
  };
  const inline = (mark: InlineMark) => {
    const { start, end } = selection();
    apply(toggleInline(textRef.current, start, end, mark));
  };
  const lines = (mark: LineMark) => {
    const { start, end } = selection();
    apply(toggleLines(textRef.current, start, end, mark));
  };
  const link = () => {
    const { start, end } = selection();
    apply(insertLink(textRef.current, start, end, t("notes.link_text")));
  };

  const onAreaKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (markdown && mod && !e.shiftKey && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "b") { e.preventDefault(); inline("bold"); return; }
      if (key === "i") { e.preventDefault(); inline("italic"); return; }
      if (key === "k") { e.preventDefault(); link(); return; }
    }
    // Code and settings files: Tab indents (two spaces) instead of leaving the field.
    if (!markdown && e.key === "Tab" && !mod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const { start, end } = selection();
      const indent = "  ";
      apply({ text: textRef.current.slice(0, start) + indent + textRef.current.slice(end), start: start + indent.length, end: start + indent.length });
      return;
    }
    if (markdown && e.key === "Enter" && !mod && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      const area = e.currentTarget;
      if (area.selectionStart !== area.selectionEnd) return;
      const edit = continueList(area.value, area.selectionStart);
      if (edit) {
        e.preventDefault();
        apply(edit);
      }
    }
  };

  // Ctrl+S anywhere in the editor; Escape closes (the dialogs handle their own).
  const trapRef = useFocusTrap({ isActive: !problem && !askDiscard, onEscape: () => void close(), restoreFocus: true });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // ---- Rendering -------------------------------------------------------------
  const status = readOnly ? null : (
    <span
      // On a phone only a problem is spelled out; the file name needs the room.
      className={cn("text-xs whitespace-nowrap", state === "failed" || state === "conflict" ? "text-destructive" : "text-muted-foreground max-sm:sr-only")}
      role="status"
      aria-live="polite"
    >
      {state === "saving" && <Loader2 className="inline w-3 h-3 mr-1 animate-spin" />}
      {t(`notes.status.${state}`)}
    </span>
  );

  const toolbar: { label: string; icon: typeof Bold; run: () => void }[] = [
    { label: t("notes.toolbar.h1"), icon: Heading1, run: () => lines("h1") },
    { label: t("notes.toolbar.h2"), icon: Heading2, run: () => lines("h2") },
    { label: t("notes.toolbar.bold"), icon: Bold, run: () => inline("bold") },
    { label: t("notes.toolbar.italic"), icon: Italic, run: () => inline("italic") },
    { label: t("notes.toolbar.strike"), icon: Strikethrough, run: () => inline("strike") },
    { label: t("notes.toolbar.code"), icon: Code, run: () => inline("code") },
    { label: t("notes.toolbar.quote"), icon: Quote, run: () => lines("quote") },
    { label: t("notes.toolbar.bullet"), icon: List, run: () => lines("bullet") },
    { label: t("notes.toolbar.number"), icon: ListOrdered, run: () => lines("number") },
    { label: t("notes.toolbar.task"), icon: ListTodo, run: () => lines("task") },
    { label: t("notes.toolbar.link"), icon: Link, run: link },
  ];

  return (
    <div
      ref={trapRef}
      className="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)]"
      role="dialog"
      aria-modal="true"
      aria-label={resource.name}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="ghost" size="icon" onClick={() => void close()} aria-label={t("notes.close")} title={t("notes.close")}>
          <X className="w-4 h-4" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={resource.name}>{resource.name}</h2>
        {readOnly && (
          <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground" title={t("notes.read_only_hint")}>
            <Lock className="w-3 h-3" />{t("notes.read_only")}
          </span>
        )}
        {status}
        {state === "failed" && (
          <Button variant="outline" size="sm" onClick={() => void save()}>{t("notes.retry")}</Button>
        )}
        {!readOnly && (
          <Button size="sm" onClick={() => void save()} disabled={loaded !== "ready" || state === "saving" || state === "conflict"}>
            <Save className="w-4 h-4 sm:mr-1" /><span className="max-sm:sr-only">{t("notes.save")}</span>
          </Button>
        )}
      </div>

      {loaded === "loading" && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="w-5 h-5 mr-2 animate-spin" />{t("notes.loading")}
        </div>
      )}
      {loaded === "failed" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm">
          <p className="text-destructive">{t("notes.load_failed")}</p>
          <Button variant="outline" size="sm" onClick={() => void load(resource.name)}>{t("notes.retry")}</Button>
        </div>
      )}

      {loaded === "ready" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {!readOnly && (
            <div className="flex items-center gap-1 border-b border-border px-3">
              <div role="tablist" className="flex shrink-0">
                <TabButton active={tab === "view"} onClick={() => setTab("view")}>{t("notes.view")}</TabButton>
                <TabButton active={tab === "edit"} onClick={() => setTab("edit")}>{t("notes.edit")}</TabButton>
              </div>
              {tab === "edit" && markdown && (
                <div role="toolbar" aria-label={t("notes.toolbar.label")} className="ml-2 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1">
                  {toolbar.map(({ label, icon: Icon, run }) => (
                    <button
                      key={label}
                      type="button"
                      className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      title={label}
                      aria-label={label}
                      // Keep the selection in the text field.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={run}
                    >
                      <Icon className="w-4 h-4" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            <div className="mx-auto flex h-full max-w-4xl flex-col px-4 py-4">
              {tab === "edit" && !readOnly ? (
                <textarea
                  ref={areaRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onAreaKeyDown}
                  spellCheck
                  autoFocus
                  aria-label={resource.name}
                  placeholder={markdown ? t("notes.placeholder") : undefined}
                  className="min-h-[60vh] w-full flex-1 resize-none bg-transparent font-mono text-sm leading-relaxed outline-none"
                />
              ) : text.trim() === "" ? (
                <p className="text-sm text-muted-foreground">{t("notes.empty_preview")}</p>
              ) : (
                <TextFileView name={resource.name} text={text} />
              )}
            </div>
          </div>
        </div>
      )}

      {problem && (
        <ConflictDialog
          name={resource.name}
          gone={problem === "gone"}
          onCopy={() => void saveAsCopy()}
          onReload={() => void reload()}
          onCancel={() => { setProblem(null); setAutosaveOff(true); }}
        />
      )}
      <ConfirmDialog
        isOpen={askDiscard}
        onClose={() => setAskDiscard(false)}
        onConfirm={() => { setAskDiscard(false); onClose(); }}
        title={t("notes.discard_title")}
        message={t("notes.discard_text")}
        confirmText={t("notes.discard_confirm")}
        variant="destructive"
      />
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        // An inset shadow, not a border: the global "* { border-color }" rule wins over border colours.
        "px-3 py-2 text-sm",
        active ? "font-medium text-foreground shadow-[inset_0_-2px_0_var(--color-primary)]" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ConflictDialog({ name, gone, onCopy, onReload, onCancel }: { name: string; gone: boolean; onCopy: () => void; onReload: () => void; onCancel: () => void }) {
  const t = useXT();
  const ref = useFocusTrap({ isActive: true, onEscape: onCancel, restoreFocus: true });
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="note-conflict-title" className="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-xl">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 w-5 h-5 shrink-0 text-amber-500" />
          <div className="space-y-2">
            <h3 id="note-conflict-title" className="text-sm font-semibold">{t(gone ? "notes.gone_title" : "notes.conflict_title")}</h3>
            <p className="text-sm text-muted-foreground">{t(gone ? "notes.gone" : "notes.conflict_text", { name })}</p>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse sm:flex-wrap">
          <Button size="sm" onClick={onCopy}>{t("notes.conflict_copy")}</Button>
          {!gone && <Button size="sm" variant="outline" onClick={onReload}>{t("notes.conflict_reload")}</Button>}
          <Button size="sm" variant="ghost" onClick={onCancel}>{t("notes.conflict_cancel")}</Button>
        </div>
      </div>
    </div>
  );
}
