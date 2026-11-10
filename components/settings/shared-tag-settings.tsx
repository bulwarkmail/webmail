"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Loader2, Pencil, Plus, Trash2, Users, X } from "@/components/icons";
import { TagBadge } from "@/components/email/tag-badge";
import { useAccountTags, TagScopeContext, clientForLogin, type TagScope } from "@/hooks/use-account-tags";
import { useRestriction } from "@/hooks/use-restriction";
import { MetadataTooLargeError } from "@/lib/jmap/bulwark-metadata";
import type { MailboxRights } from "@/lib/jmap/types";
import { chooseKeywordId, isKeywordNameTaken, MAX_KEYWORD_ID_LENGTH } from "@/lib/keyword-nesting";
import { MAX_SHARED_TAG_LABEL, groupAccountTags, type SharedTagChange } from "@/lib/shared-tags";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { KEYWORD_PALETTE, useSettingsStore, type KeywordDefinition } from "@/stores/settings-store";
import { SharedTagsSaveDeferredError, saveSharedTags, sharedTagsKey, useSharedTagsStore } from "@/stores/shared-tags-store";
import { toast } from "@/stores/toast-store";
import { toUnicodeEmail } from "@/lib/idn";
import { KeywordColorPicker } from "./keyword-settings";
import { OrgLockedNote } from "./org-locked-note";
import { SettingsSection } from "./settings-section";

/** Whether the rights on a group's Inbox let the user change its metadata. */
export function maySetSharedTags(rights: Partial<MailboxRights> | null | undefined): boolean {
  if (!rights) return false;
  // Stalwart 1.0 names the right; a server that doesn't counts renaming.
  return typeof rights.maySetMetadata === "boolean" ? rights.maySetMetadata : rights.mayRename === true;
}

/**
 * The user's rights on the Inbox of a confirmed group account, from the
 * folder list or asked once. Nothing is asked for any other account.
 */
function useInboxRights(scope: TagScope, enabled: boolean): Partial<MailboxRights> | null | undefined {
  const fromStore = useEmailStore((state) =>
    state.mailboxes.find((mailbox) => mailbox.accountId === scope.accountId && mailbox.role === "inbox")?.myRights);
  const [fetched, setFetched] = useState<Partial<MailboxRights> | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled || fromStore) return;
    let cancelled = false;
    const client = clientForLogin(scope.loginId) as unknown as { getMailboxes?: (accountId?: string) => Promise<Array<{ role?: string; myRights?: MailboxRights }>> } | null;
    if (!client?.getMailboxes) return;
    client.getMailboxes(scope.accountId)
      .then((mailboxes) => { if (!cancelled) setFetched(mailboxes.find((m) => m.role === "inbox")?.myRights ?? null); })
      .catch(() => { if (!cancelled) setFetched(null); });
    return () => { cancelled = true; };
  }, [enabled, fromStore, scope.loginId, scope.accountId]);
  return enabled ? fromStore ?? fetched : undefined;
}

function SharedTagForm({
  initial,
  fixedId,
  taken,
  saving,
  onSave,
  onCancel,
}: {
  initial?: KeywordDefinition;
  /** The id stays: an existing tag or one found on messages. */
  fixedId?: string;
  /** The account's other tags, whose ids and names a new tag can't have. */
  taken: KeywordDefinition[];
  saving: boolean;
  /** `color` only when it was picked (or the tag is new), so a color this version doesn't know survives a rename. */
  onSave: (id: string, value: { label: string; color?: string }) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("shared_tags");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [color, setColor] = useState(initial?.color ?? "blue");
  const [colorPicked, setColorPicked] = useState(false);
  const id = fixedId ?? chooseKeywordId(null, label, taken.map((tag) => tag.id));
  const duplicate = !fixedId && isKeywordNameTaken(taken, null, label);
  const tooLong = !fixedId && id.length > MAX_KEYWORD_ID_LENGTH;
  const valid = label.trim().length > 0 && id.length > 0 && !duplicate && !tooLong;
  const keepsColor = !!initial && !colorPicked;
  const save = () => {
    if (valid && !saving) onSave(id, keepsColor ? { label: label.trim() } : { label: label.trim(), color });
  };

  return (
    <div className="space-y-3 rounded-md border border-primary/30 bg-accent/30 p-3" data-testid="shared-tag-form">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor={`shared-tag-label-${fixedId ?? "new"}`}>
          {t("name")}
        </label>
        <input
          id={`shared-tag-label-${fixedId ?? "new"}`}
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={MAX_SHARED_TAG_LABEL}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
          }}
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-hidden"
        />
        {duplicate && <p className="mt-1 text-xs text-destructive">{t("exists")}</p>}
        {tooLong && <p className="mt-1 text-xs text-destructive">{t("too_long")}</p>}
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t("color")}</p>
        <KeywordColorPicker value={color} onChange={(next) => { setColor(next); setColorPicked(true); }} />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-muted sm:min-h-0"
        >
          <X className="h-3.5 w-3.5" />
          {t("cancel")}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!valid || saving}
          className="flex min-h-[44px] items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 sm:min-h-0"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          {t("save")}
        </button>
      </div>
    </div>
  );
}

const ICON_BUTTON = "grid h-11 w-11 place-items-center rounded-md text-muted-foreground hover:bg-muted sm:h-8 sm:w-8";

/**
 * The shared tags of one group account. Read-only with "Set by your
 * organisation" when the admin locked `sharedTags`, read-only with a note
 * when the user may not change the group's Inbox, and a one-line note
 * instead of the editor when the server keeps no metadata or couldn't be
 * read.
 */
function SharedAccountTagEditor({ scope, name }: { scope: TagScope; name: string }) {
  const t = useTranslations("shared_tags");
  const key = sharedTagsKey(scope.loginId, scope.accountId);
  const { status } = useAccountTags(scope);
  const entry = useSharedTagsStore((state) => state.entries[key]);
  const nested = useSettingsStore((state) => state.nestedTags);
  const { locked } = useRestriction("sharedTags");
  const rights = useInboxRights(scope, status === "ready");
  const canWrite = maySetSharedTags(rights);
  const editable = !locked && canWrite;
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());

  const { shared, discovered } = useMemo(() => {
    if (status !== "ready" || !entry) return { shared: [] as KeywordDefinition[], discovered: [] as KeywordDefinition[] };
    const { definitions, discoveredIds } = groupAccountTags(entry.tags, entry.discovered, nested);
    const found = new Set(discoveredIds);
    return { shared: entry.tags, discovered: definitions.filter((tag) => found.has(tag.id)) };
  }, [status, entry, nested]);
  const taken = useMemo(() => [...shared, ...discovered], [shared, discovered]);

  // Back to the row's edit button once a change is saved.
  useEffect(() => {
    if (!focusId) return;
    editButtons.current.get(focusId)?.focus();
    setFocusId(null);
  }, [focusId, shared]);

  if (status === "personal") return null;

  const save = async (change: SharedTagChange) => {
    const client = clientForLogin(scope.loginId);
    if (!client) return false;
    setSaving(true);
    try {
      await saveSharedTags(key, scope.accountId, client, [change]);
      return true;
    } catch (error) {
      if (error instanceof SharedTagsSaveDeferredError) {
        // Kept and shown; sent again when the server answers.
        toast.warning(t("save_failed"));
        return true;
      }
      toast.error(error instanceof MetadataTooLargeError ? t("too_many") : t("save_failed"));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const heading = (
    <div className="flex min-w-0 items-center gap-2">
      <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate text-sm font-medium text-foreground">{toUnicodeEmail(name)}</span>
    </div>
  );

  if (status === "loading") {
    return (
      <div className="space-y-2" data-testid="shared-tags-account" data-status="loading">
        {heading}
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("loading")}
        </p>
      </div>
    );
  }

  if (status === "unsupported" || status === "unavailable") {
    return (
      <div className="space-y-2" data-testid="shared-tags-account" data-status={status}>
        {heading}
        <p className="text-xs text-muted-foreground" data-testid={`shared-tags-${status}`}>{t(status)}</p>
      </div>
    );
  }

  const row = (tag: KeywordDefinition, found: boolean) => {
    if (editing && editing.id === tag.id) {
      const raw = entry?.stored?.entries[tag.id];
      // The form shows the stored color when this version knows it.
      const initial = { ...tag, color: typeof raw?.color === "string" && KEYWORD_PALETTE[raw.color] ? raw.color : tag.color };
      return (
        <SharedTagForm
          key={tag.id}
          initial={initial}
          fixedId={tag.id}
          taken={taken}
          saving={saving}
          onCancel={() => { setEditing(null); setFocusId(tag.id); }}
          onSave={async (id, value) => {
            const next = found ? { label: value.label, color: value.color ?? tag.color } : value;
            if (await save({ id, value: next })) { setEditing(null); setFocusId(id); }
          }}
        />
      );
    }
    const confirming = editable && confirmDelete === tag.id;
    return (
      <div
        key={tag.id}
        className="flex min-h-[44px] flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 sm:min-h-0 sm:flex-nowrap"
        data-testid="shared-tag-row"
        data-tag-id={tag.id}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <TagBadge tagId={tag.id} variant="badge" className="text-xs" />
          {found && <span className="truncate text-xs text-muted-foreground">{t("found_on_messages")}</span>}
        </div>
        {confirming ? (
          <div className="flex basis-full flex-wrap items-center justify-end gap-1 sm:basis-auto sm:flex-nowrap" data-testid="shared-tag-delete-confirm">
            <span className="text-xs text-muted-foreground">{t("delete_confirm")}</span>
            <button
              type="button"
              onClick={async () => { if (await save({ id: tag.id, value: null })) setConfirmDelete(null); }}
              className="min-h-[44px] rounded-md px-3 py-1 text-xs text-destructive hover:bg-destructive/10 sm:min-h-0"
            >
              {t("delete")}
            </button>
            <button
              type="button"
              onClick={() => { setConfirmDelete(null); setFocusId(tag.id); }}
              className="min-h-[44px] rounded-md px-3 py-1 text-xs hover:bg-muted sm:min-h-0"
            >
              {t("cancel")}
            </button>
          </div>
        ) : editable && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              ref={(el) => { if (el) editButtons.current.set(tag.id, el); else editButtons.current.delete(tag.id); }}
              onClick={() => { setEditing({ id: tag.id }); setConfirmDelete(null); }}
              className={cn(ICON_BUTTON, "hover:text-foreground")}
              title={found ? t("name_it", { name: tag.id }) : t("edit_tag", { name: tag.label })}
              aria-label={found ? t("name_it", { name: tag.id }) : t("edit_tag", { name: tag.label })}
            >
              {found ? <Plus className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
            </button>
            {!found && (
              <button
                type="button"
                onClick={() => { setConfirmDelete(tag.id); setEditing(null); }}
                className={cn(ICON_BUTTON, "hover:text-destructive")}
                title={t("delete_tag", { name: tag.label })}
                aria-label={t("delete_tag", { name: tag.label })}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <TagScopeContext.Provider value={scope}>
      <div className="space-y-2" data-testid="shared-tags-account" data-status="ready" data-editable={editable || undefined}>
        {heading}
        {shared.length === 0 && discovered.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        )}
        {shared.map((tag) => row(tag, false))}
        {discovered.map((tag) => row(tag, true))}
        {(entry?.pending.length ?? 0) > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="shared-tags-pending">{t("save_pending")}</p>
        )}
        {locked ? (
          <OrgLockedNote />
        ) : !canWrite ? (
          <p className="text-xs text-muted-foreground" data-testid="shared-tags-no-rights">
            {rights === undefined ? t("loading") : t("no_rights")}
          </p>
        ) : editing && !editing.id ? (
          <SharedTagForm
            taken={taken}
            saving={saving}
            onCancel={() => setEditing(null)}
            onSave={async (id, value) => { if (await save({ id, value })) { setEditing(null); setFocusId(id); } }}
          />
        ) : (
          <button
            type="button"
            onClick={() => { setEditing({}); setConfirmDelete(null); }}
            className={cn(
              "flex min-h-[44px] items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors sm:min-h-0",
              "hover:border-primary hover:bg-accent hover:text-foreground",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("add")}
          </button>
        )}
      </div>
    </TagScopeContext.Provider>
  );
}

/**
 * Settings > Folders & tags > Shared tags: the tags of each group mailbox
 * the user is a member of. Hidden without group accounts. The account list
 * is worked out again whenever the folder list changes, which it does after
 * every session change.
 */
export function SharedTagSettings() {
  const t = useTranslations("shared_tags");
  const client = useAuthStore((state) => state.client);
  const loginId = useAuthStore((state) => state.activeAccountId);
  const mailboxes = useEmailStore((state) => state.mailboxes);
  const accounts = useMemo(
    () => {
      void mailboxes;
      return client && typeof client.getSharedAccounts === "function"
        ? client.getSharedAccounts().filter((account) => !account.isPrimary && account.capabilities.mail && client.getAccountInfo?.(account.id)?.isPersonal === false)
        : [];
    },
    [client, mailboxes],
  );
  const entries = useSharedTagsStore((state) => state.entries);
  if (!loginId || accounts.length === 0) return null;
  // Sharing by a person isn't a group: shown only once known not to be one.
  const groups = accounts.filter((account) => entries[sharedTagsKey(loginId, account.id)]?.status !== "personal");
  return (
    <div className={groups.length === 0 ? "hidden" : undefined}>
      <SettingsSection id="shared-tags" title={t("title")} description={t("description")}>
        <div className="space-y-5" data-testid="shared-tag-settings">
          {accounts.map((account) => (
            <SharedAccountTagEditor key={account.id} scope={{ loginId, accountId: account.id }} name={account.name} />
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
