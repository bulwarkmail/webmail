"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Email, MailboxRights } from "@/lib/jmap/types";
import { groupAccountTags } from "@/lib/shared-tags";
import { useAuthStore } from "@/stores/auth-store";
import { resolveEmailBlobContext, useEmailStore } from "@/stores/email-store";
import { useSettingsStore, type KeywordDefinition } from "@/stores/settings-store";
import {
  loadSharedTags,
  sharedTagsKey,
  useSharedTagsStore,
  type SharedTagsClient,
  type SharedTagsEntry,
  type SharedTagsStatus,
} from "@/stores/shared-tags-store";

/**
 * Which account's tags apply: a JMAP account other than the login's own,
 * reached through the login `loginId`. Null means the user's own tags.
 */
export interface TagScope {
  loginId: string;
  accountId: string;
}

/**
 * The tag scope of whatever is drawn inside: a message row, the open
 * message, a group account's sidebar section. Tag badges, pickers and
 * names read it, so each message shows its own account's tags (the unified
 * inbox mixes accounts).
 */
export const TagScopeContext = createContext<TagScope | null>(null);

/** The scope of a message: its own account when that isn't the login's. */
export function tagScopeOf(email: Pick<Email, "sourceClientAccountId" | "sourceAccountId"> | null | undefined): TagScope | null {
  if (!email) return null;
  try {
    const auth = useAuthStore.getState();
    const { client, accountId, clientAccountId } = resolveEmailBlobContext(email, auth.client);
    if (!client || !accountId || accountId === client.getAccountId()) return null;
    const loginId = clientAccountId ?? auth.activeAccountId;
    return loginId ? { loginId, accountId } : null;
  } catch {
    // No session to tell (a stand-in store, a signed-out moment): own tags.
    return null;
  }
}

/**
 * tagScopeOf for a message on screen, kept stable between renders and
 * worked out again when the view changes (an unstamped message belongs to
 * the account of the folder on screen). The component draws again only when
 * the scope itself changes: following the selected folder instead drew every
 * list row again on each folder click, though nearly every folder is the
 * login's own.
 */
export function useEmailTagScope(email: Pick<Email, "sourceClientAccountId" | "sourceAccountId"> | null | undefined): TagScope | null {
  useAuthStore((state) => state.activeAccountId);
  // Worked out against the store's state: the folder on screen and the
  // account viewed decide it.
  const key = useEmailStore(() => {
    const scope = tagScopeOf(email);
    return scope ? `${scope.loginId}\n${scope.accountId}` : "";
  });
  return useMemo(() => {
    if (!key) return null;
    const [loginId, accountId] = key.split("\n");
    return { loginId, accountId };
  }, [key]);
}

/** The scope shared by every message given, or null when they differ. */
export function commonTagScope(emails: Array<Pick<Email, "sourceClientAccountId" | "sourceAccountId">>): TagScope | null {
  const scopes = emails.map((email) => tagScopeOf(email));
  const first = scopes[0] ?? null;
  const same = scopes.every((scope) => scope?.loginId === first?.loginId && scope?.accountId === first?.accountId);
  return same ? first : null;
}

export function clientForLogin(loginId: string): SharedTagsClient | null {
  const auth = useAuthStore.getState();
  return (auth.getClientForAccount?.(loginId) as SharedTagsClient | undefined)
    ?? (loginId === auth.activeAccountId ? (auth.client as SharedTagsClient | null) : null);
}

/** Whether the rights on a group's Inbox let the user change its metadata. */
export function maySetSharedTags(rights: Partial<MailboxRights> | null | undefined): boolean {
  if (!rights) return false;
  // Stalwart 1.0 names the right; a server that doesn't counts renaming.
  return typeof rights.maySetMetadata === "boolean" ? rights.maySetMetadata : rights.mayRename === true;
}

/**
 * The user's rights on the Inbox of a confirmed group account, from the
 * folder list or asked once; undefined while not known. Nothing is asked
 * when not `enabled`.
 */
export function useInboxRights(scope: TagScope | null, enabled: boolean): Partial<MailboxRights> | null | undefined {
  const accountId = enabled ? scope?.accountId : undefined;
  const loginId = scope?.loginId;
  const fromStore = useEmailStore((state) =>
    accountId ? state.mailboxes.find((mailbox) => mailbox.accountId === accountId && mailbox.role === "inbox")?.myRights : undefined);
  const [fetched, setFetched] = useState<Partial<MailboxRights> | null | undefined>(undefined);
  useEffect(() => {
    if (!accountId || !loginId || fromStore) return;
    let cancelled = false;
    const client = clientForLogin(loginId) as unknown as { getMailboxes?: (accountId?: string) => Promise<Array<{ role?: string; myRights?: MailboxRights }>> } | null;
    if (!client?.getMailboxes) return;
    client.getMailboxes(accountId)
      .then((mailboxes) => { if (!cancelled) setFetched(mailboxes.find((m) => m.role === "inbox")?.myRights ?? null); })
      .catch(() => { if (!cancelled) setFetched(null); });
    return () => { cancelled = true; };
  }, [accountId, loginId, fromStore]);
  return accountId ? fromStore ?? fetched : undefined;
}

/** Starts loading a scope's shared tags (once per sign-in). */
export function ensureSharedTags(scope: TagScope): void {
  const client = clientForLogin(scope.loginId);
  if (client) void loadSharedTags(sharedTagsKey(scope.loginId, scope.accountId), scope.accountId, client);
}

const derived = new WeakMap<SharedTagsEntry, Map<boolean, KeywordDefinition[]>>();

/** The shared definitions plus the tags found on the messages, worked out once per entry. */
function groupDefinitions(entry: SharedTagsEntry, nested: boolean): KeywordDefinition[] {
  let byNesting = derived.get(entry);
  if (!byNesting) {
    byNesting = new Map();
    derived.set(entry, byNesting);
  }
  let definitions = byNesting.get(nested);
  if (!definitions) {
    definitions = groupAccountTags(entry.tags, entry.discovered, nested).definitions;
    byNesting.set(nested, definitions);
  }
  return definitions;
}

export interface AccountTags {
  /** The tags to offer and name things by in this scope. */
  definitions: KeywordDefinition[];
  /** True when they are the group account's shared tags. */
  shared: boolean;
  /** `personal` for the user's own account. */
  status: SharedTagsStatus;
}

/**
 * The tags of a scope: in a group account whose server keeps metadata, its
 * shared definitions plus every tag found on its messages; everywhere else
 * (own account, a mailbox a person shared, a server without metadata, while
 * loading) the user's own tags. Definitions that arrive after the first
 * render apply as soon as they are there.
 *
 * `scope` undefined reads TagScopeContext; null means the user's own tags.
 */
export function useAccountTags(scope?: TagScope | null): AccountTags {
  const contextScope = useContext(TagScopeContext);
  const effective = scope === undefined ? contextScope : scope;
  const key = effective ? sharedTagsKey(effective.loginId, effective.accountId) : null;
  const entry = useSharedTagsStore((state) => (key ? state.entries[key] : undefined));
  const personal = useSettingsStore((state) => state.emailKeywords);
  const nested = useSettingsStore((state) => state.nestedTags);
  const loginId = effective?.loginId;
  const accountId = effective?.accountId;

  useEffect(() => {
    if (loginId && accountId) ensureSharedTags({ loginId, accountId });
  }, [loginId, accountId]);

  return useMemo(() => {
    if (!effective) return { definitions: personal, shared: false, status: "personal" };
    if (entry?.status !== "ready") return { definitions: personal, shared: false, status: entry?.status ?? "loading" };
    return { definitions: groupDefinitions(entry, nested), shared: true, status: "ready" };
    // `effective` is fully described by the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, entry, personal, nested]);
}
