"use client";

import React, { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  useSettingsStore,
  KEYWORD_PALETTE,
  KEYWORD_PALETTE_ROWS,
  getKeywordVisibility,
  type KeywordDefinition,
  type KeywordVisibility,
} from "@/stores/settings-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { SettingsSection, SettingItem, ToggleSwitch, Select } from "./settings-section";
import { Plus, Pencil, Trash2, GripVertical, Check, X, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { KEYWORD_PREFIX } from "@/lib/thread-utils";
import { findUnrecognizedKeywords, type UnrecognizedKeyword } from "@/lib/keyword-discovery";
import {
  buildKeywordTree,
  composeKeywordId,
  getParentKeywordId,
  hasChildKeywords,
  isKeywordDescendant,
  keywordLevels,
  type KeywordNode,
  MAX_KEYWORD_ID_LENGTH,
} from "@/lib/keyword-nesting";
import { formatKeyword, keywordRenderings } from "@/lib/keyword-format";
import { useShortenedText } from "@/hooks/use-shortened-text";
import { TagBadge } from "@/components/email/tag-badge";

/** Lighter, base and darker shade of each hue, one row per shade. */
function KeywordColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      {KEYWORD_PALETTE_ROWS.map((row, index) => (
        <div key={index} className="flex flex-wrap gap-1.5">
          {row.map((colorKey) => (
            <button
              key={colorKey}
              type="button"
              onClick={() => onChange(colorKey)}
              className={cn(
                "w-6 h-6 rounded-full transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                KEYWORD_PALETTE[colorKey].dot,
                value === colorKey && "ring-2 ring-offset-2 ring-offset-background ring-foreground"
              )}
              aria-label={colorKey}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function KeywordRow({
  keyword,
  keywords,
  nestedTags,
  onEdit,
  onDelete,
  onVisibilityChange,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragOver,
  isDragging,
}: {
  keyword: KeywordDefinition;
  keywords: KeywordDefinition[];
  nestedTags: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onVisibilityChange: (visibility: KeywordVisibility) => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  isDragOver: boolean;
  isDragging: boolean;
}) {
  const t = useTranslations("settings.keywords");
  const hasChildren = hasChildKeywords(keyword.id, keywords);
  // Measured with the prefix attached, since that is what occupies the column.
  const keywordCandidates = (nestedTags ? keywordRenderings(keywordLevels(keyword.id)) : [keyword.id])
    .map((rendering) => KEYWORD_PREFIX + rendering);
  const [keywordRef, shortenedKeyword] = useShortenedText(keywordCandidates);
  const visibilityOptions = [
    { value: "show", label: t("visibility.show") },
    { value: "unread", label: t("visibility.unread") },
    { value: "hide", label: t("visibility.hide") },
  ];

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={cn(
        "flex items-center gap-3 py-2.5 px-3 rounded-md border bg-background group transition-opacity",
        isDragging ? "opacity-40" : "opacity-100",
        isDragOver ? "border-primary" : "border-border"
      )}
    >
      <GripVertical className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-50 cursor-grab" />
      <div className="flex min-w-0 flex-1">
        <TagBadge tagId={keyword.id} variant="badge" className="text-xs" />
      </div>
      <span
        ref={keywordRef}
        className="hidden md:block min-w-0 max-w-52 truncate text-xs text-muted-foreground font-mono"
        title={KEYWORD_PREFIX + keyword.id}
      >
        {shortenedKeyword}
      </span>
      <Select
        value={getKeywordVisibility(keyword)}
        onChange={(value) => onVisibilityChange(value as KeywordVisibility)}
        options={visibilityOptions}
        ariaLabel={t("visibility_field")}
        className="text-xs py-1"
      />
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={onEdit}
          className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title={t("edit")}
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={hasChildren}
          className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          title={hasChildren ? t("has_children_delete") : t("delete")}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function KeywordEditForm({
  initial,
  keywords,
  existingIds,
  nestedTags,
  onSave,
  onCancel,
}: {
  initial?: KeywordDefinition;
  keywords: KeywordDefinition[];
  existingIds: string[];
  nestedTags: boolean;
  onSave: (keyword: KeywordDefinition) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("settings.keywords");
  const [label, setLabel] = useState(initial?.label || "");
  const [color, setColor] = useState(initial?.color || "blue");
  const [parentId, setParentId] = useState(initial ? getParentKeywordId(initial.id) ?? "" : "");
  const isEditing = !!initial;

  // Renaming or re-parenting a tag rewrites the keyword on every message below
  // it, and this client only knows about the tags in its own settings - the
  // server may hold nested keywords created elsewhere. Freeze the identity of a
  // tag that has children and allow the color to change.
  const isLocked = !!initial && hasChildKeywords(initial.id, keywords);

  const normalizedId = isLocked && initial ? initial.id : composeKeywordId(parentId || null, label);
  const isDuplicate = normalizedId.length > 0 && existingIds.includes(normalizedId);
  const isTooLong = normalizedId.length > MAX_KEYWORD_ID_LENGTH;
  const isValid = normalizedId.length > 0 && label.trim().length > 0 && !isDuplicate && !isTooLong;

  // Every tag is a candidate parent except the one being edited and anything
  // already below it, which would detach the branch from its own root.
  const parentOptions: { value: string; label: string }[] = [{ value: "", label: t("no_parent") }];
  const collectParentOptions = (nodes: KeywordNode[]) => {
    for (const node of nodes) {
      if (initial && (node.id === initial.id || isKeywordDescendant(node.id, initial.id))) continue;
      parentOptions.push({ value: node.id, label: formatKeyword(node.id, keywords, true) });
      collectParentOptions(node.children);
    }
  };
  collectParentOptions(buildKeywordTree(keywords));

  const handleSave = () => {
    if (!isValid) return;
    if (isLocked && initial) {
      onSave({ ...initial, color });
      return;
    }
    onSave({ id: normalizedId, label: label.trim(), color });
  };

  return (
    <div className="space-y-3 p-3 rounded-md border border-primary/30 bg-accent/30">
      {nestedTags && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            {t("parent_field")}
          </label>
          <Select
            value={parentId}
            onChange={setParentId}
            options={parentOptions}
            disabled={isLocked}
            ariaLabel={t("parent_field")}
            className="w-full"
          />
        </div>
      )}
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">
          {t("label_field")}
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={isLocked}
          className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          placeholder={t("label_placeholder")}
          autoFocus
          maxLength={30}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
        />
        {nestedTags && normalizedId.length > 0 && (
          <p className="text-xs text-muted-foreground font-mono mt-1 break-all">
            {KEYWORD_PREFIX + normalizedId}
          </p>
        )}
        {isLocked && (
          <p className="text-xs text-muted-foreground mt-1">{t("has_children_locked")}</p>
        )}
        {isDuplicate && (
          <p className="text-xs text-destructive mt-1">{t("id_exists")}</p>
        )}
        {isTooLong && (
          <p className="text-xs text-destructive mt-1">
            {t("too_long", { max: MAX_KEYWORD_ID_LENGTH })}
          </p>
        )}
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
          {t("color_field")}
        </label>
        <KeywordColorPicker value={color} onChange={setColor} />
      </div>
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted transition-colors"
        >
          <X className="w-3.5 h-3.5" />
          {t("cancel")}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!isValid}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          <Check className="w-3.5 h-3.5" />
          {isEditing ? t("save") : t("add")}
        </button>
      </div>
    </div>
  );
}

/**
 * One found keyword, with the name and colour it would be adopted under.
 *
 * The id is shown but not editable. It is what the messages already say, and
 * rewording it would create a tag pointing at nothing while leaving the real
 * one just as invisible as before - which is the whole problem being fixed.
 */
function UnrecognizedKeywordRow({
  entry,
  draft,
  onChange,
  onAdd,
}: {
  entry: UnrecognizedKeyword;
  draft: { label: string; color: string };
  onChange: (draft: { label: string; color: string }) => void;
  onAdd: () => void;
}) {
  const t = useTranslations("settings.keywords");
  const [pickingColor, setPickingColor] = useState(false);
  const canAdd = draft.label.trim().length > 0;

  return (
    <div className="space-y-2 py-2.5 px-3 rounded-md border border-border bg-background">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPickingColor((open) => !open)}
          className={cn(
            "w-5 h-5 shrink-0 rounded-full transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            KEYWORD_PALETTE[draft.color]?.dot ?? KEYWORD_PALETTE.gray.dot,
          )}
          aria-label={t("color_field")}
          aria-expanded={pickingColor}
        />
        <input
          type="text"
          value={draft.label}
          onChange={(e) => onChange({ ...draft, label: e.target.value })}
          className="min-w-0 flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder={t("label_placeholder")}
          maxLength={30}
          aria-label={t("label_field")}
          onKeyDown={(e) => e.key === "Enter" && canAdd && onAdd()}
        />
        <button
          type="button"
          onClick={onAdd}
          disabled={!canAdd}
          className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5" />
          {t("add")}
        </button>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono" title={entry.keyword}>
          {entry.keyword}
        </span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">{t("unrecognized.messages", { count: entry.count })}</span>
      </div>
      {pickingColor && (
        <KeywordColorPicker
          value={draft.color}
          onChange={(color) => {
            onChange({ ...draft, color });
            setPickingColor(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Tags that exist on the server but not in these settings.
 *
 * A tag is a keyword on the messages plus a name and colour held only here, so
 * losing this browser's settings hides tags that are still perfectly intact on
 * the server: the mail keeps its `$label:q3-invoices`, and nothing left knows
 * that keyword was ever called anything. Scanning finds those keywords and
 * offers them back, named as well as an id can be read, so recovering a tag
 * does not depend on the user remembering its exact spelling.
 *
 * The scan is on demand rather than automatic. It walks the message list a page
 * at a time - the only way to find keywords in JMAP - which is far too much
 * work to spend on merely opening a settings page.
 */
function UnrecognizedKeywords() {
  const t = useTranslations("settings.keywords");
  const { emailKeywords, nestedTags, addKeyword } = useSettingsStore();
  const { client } = useAuthStore();
  const { fetchTagCounts } = useEmailStore();
  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState({ scanned: 0, total: 0 });
  const [scan, setScan] = useState<{ found: UnrecognizedKeyword[]; complete: boolean; scanned: number; total: number } | null>(null);
  const [error, setError] = useState(false);
  // Edits keyed by tag id, so a name typed into one row survives the others
  // being added and the list re-rendering without it.
  const [drafts, setDrafts] = useState<Record<string, { label: string; color: string }>>({});
  const abortRef = useRef<AbortController | null>(null);

  // A scan in flight has no reason to keep paging once nobody is watching.
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleScan = async () => {
    if (!client) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setIsScanning(true);
    setError(false);
    setProgress({ scanned: 0, total: 0 });
    try {
      const result = await client.discoverKeywords({
        signal: controller.signal,
        onProgress: (scanned, total) => {
          if (!controller.signal.aborted) setProgress({ scanned, total });
        },
      });
      if (controller.signal.aborted) return;
      setScan({
        found: findUnrecognizedKeywords(result.keywords, emailKeywords, nestedTags),
        complete: result.complete,
        scanned: result.scanned,
        total: result.total,
      });
    } catch (err) {
      console.error("Failed to scan for unrecognized keywords:", err);
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setIsScanning(false);
    }
  };

  const handleAdd = (entries: UnrecognizedKeyword[]) => {
    for (const entry of entries) {
      const draft = drafts[entry.id] ?? entry;
      const label = draft.label.trim();
      if (!label) continue;
      addKeyword({ id: entry.id, label, color: draft.color });
    }
    if (client) fetchTagCounts(client);
  };

  // Anything added - here or by hand while the results sat on screen - stops
  // being unrecognized, so the list is filtered against the definitions on every
  // render rather than spliced when a row is used.
  const known = new Set(emailKeywords.map((keyword) => keyword.id.toLowerCase()));
  const pending = (scan?.found ?? []).filter((entry) => !known.has(entry.id.toLowerCase()));
  const addable = pending.filter((entry) => (drafts[entry.id]?.label ?? entry.label).trim().length > 0);

  return (
    <div className="space-y-3 pt-4 mt-4 border-t border-border">
      <div>
        <h4 className="text-sm font-medium">{t("unrecognized.title")}</h4>
        <p className="text-xs text-muted-foreground mt-0.5">{t("unrecognized.description")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleScan}
          disabled={isScanning || !client}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-50"
        >
          {isScanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          {scan && !isScanning ? t("unrecognized.rescan") : t("unrecognized.scan")}
        </button>
        {isScanning && (
          <span className="text-xs text-muted-foreground" role="status">
            {t("unrecognized.scanning", { scanned: progress.scanned, total: progress.total })}
          </span>
        )}
        {isScanning && (
          <button
            type="button"
            onClick={() => {
              abortRef.current?.abort();
              setIsScanning(false);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            {t("cancel")}
          </button>
        )}
        {pending.length > 1 && !isScanning && (
          <button
            type="button"
            onClick={() => handleAdd(addable)}
            disabled={addable.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("unrecognized.add_all", { count: addable.length })}
          </button>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{t("unrecognized.error")}</p>}

      {scan && !isScanning && !scan.complete && (
        <p className="text-xs text-muted-foreground">
          {t("unrecognized.partial", { scanned: scan.scanned, total: scan.total })}
        </p>
      )}

      {scan && !isScanning && pending.length === 0 && !error && (
        <p className="text-xs text-muted-foreground">{t("unrecognized.none")}</p>
      )}

      {pending.length > 0 && (
        <div className="space-y-2">
          {pending.map((entry) => (
            <UnrecognizedKeywordRow
              key={entry.id}
              entry={entry}
              draft={drafts[entry.id] ?? { label: entry.label, color: entry.color }}
              onChange={(draft) => setDrafts((current) => ({ ...current, [entry.id]: draft }))}
              onAdd={() => handleAdd([entry])}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function KeywordSettings() {
  const t = useTranslations("settings.keywords");
  const { emailKeywords, nestedTags, addKeyword, updateKeyword, renameKeyword, removeKeyword, reorderKeywords, updateSetting } =
    useSettingsStore();
  const { client } = useAuthStore();
  const { fetchTagCounts } = useEmailStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const existingIds = emailKeywords.map((k) => k.id);

  const handleDragStart = (index: number) => {
    setDragIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (index !== dragOverIndex) setDragOverIndex(index);
  };

  const handleDrop = (index: number) => {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    const reordered = [...emailKeywords];
    const [moved] = reordered.splice(dragIndex, 1);
    reordered.splice(index, 0, moved);
    reorderKeywords(reordered);
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleAdd = (keyword: KeywordDefinition) => {
    addKeyword(keyword);
    setIsAdding(false);
  };

  const handleEdit = async (keyword: KeywordDefinition) => {
    const oldId = editingId;
    if (!oldId) return;

    const idChanged = oldId !== keyword.id;

    if (idChanged && client) {
      setIsMigrating(true);
      try {
        const oldJmapKeyword = `$label:${oldId}`;
        const newJmapKeyword = `$label:${keyword.id}`;
        const migration = await client.migrateKeyword(oldJmapKeyword, newJmapKeyword);
        renameKeyword(oldId, keyword);
        fetchTagCounts(client);
        if (migration.refused > 0) {
          // Some mail kept the old keyword. The definition still follows the
          // messages that did move; the rest is what the warning is about.
          const toastModule = await import('sonner');
          toastModule.toast.warning(t("migration_error"));
        }
      } catch (error) {
        console.error("Failed to migrate keyword:", error);
        const toastModule = await import('sonner');
        toastModule.toast.error(t("migration_error"));
        setIsMigrating(false);
        return;
      }
      setIsMigrating(false);
    } else {
      updateKeyword(oldId, { label: keyword.label, color: keyword.color });
    }

    setEditingId(null);
  };

  const handleDelete = (id: string) => {
    removeKeyword(id);
  };

  const handleVisibilityChange = (id: string, visibility: KeywordVisibility) => {
    updateKeyword(id, { visibility });
  };

  return (
    <SettingsSection title={t("title")} description={t("description")}>
      <SettingItem label={t("nesting.label")} description={t("nesting.description")}>
        <ToggleSwitch
          checked={nestedTags}
          onChange={(checked) => updateSetting("nestedTags", checked)}
        />
      </SettingItem>

      <div className="space-y-2">
        {isMigrating && (
          <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground bg-accent/50 rounded-md">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t("migrating")}
          </div>
        )}
        {emailKeywords.map((keyword, index) =>
          editingId === keyword.id ? (
            <KeywordEditForm
              key={keyword.id}
              initial={keyword}
              keywords={emailKeywords}
              existingIds={existingIds.filter((id) => id !== keyword.id)}
              nestedTags={nestedTags}
              onSave={handleEdit}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <KeywordRow
              key={keyword.id}
              keyword={keyword}
              keywords={emailKeywords}
              nestedTags={nestedTags}
              onEdit={() => {
                setEditingId(keyword.id);
                setIsAdding(false);
              }}
              onDelete={() => handleDelete(keyword.id)}
              onVisibilityChange={(visibility) => handleVisibilityChange(keyword.id, visibility)}
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={() => handleDrop(index)}
              onDragEnd={handleDragEnd}
              isDragOver={dragOverIndex === index && dragIndex !== index}
              isDragging={dragIndex === index}
            />
          )
        )}

        {isAdding ? (
          <KeywordEditForm
            keywords={emailKeywords}
            existingIds={existingIds}
            nestedTags={nestedTags}
            onSave={handleAdd}
            onCancel={() => setIsAdding(false)}
          />
        ) : (
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setIsAdding(true);
                setEditingId(null);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-dashed border-border hover:border-primary hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            >
              <Plus className="w-3.5 h-3.5" />
              {t("add_keyword")}
            </button>
          </div>
        )}
      </div>

      <UnrecognizedKeywords />
    </SettingsSection>
  );
}
