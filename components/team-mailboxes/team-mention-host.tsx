'use client';

/**
 * Mentions of the user in team notes, while Bulwark is open: watches every
 * team mailbox of every signed-in login from sign-in on
 * (lib/team-mailboxes/mention-watcher.ts) and tells the user with a toast
 * ("Mabel mentioned you in “Offer”", Show opens the conversation at the
 * note) and an entry in the notification list. Nobody else hears anything.
 * Mounted once in the mail app.
 */

import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { usePolicyStore } from '@/stores/policy-store';
import { toast } from '@/stores/toast-store';
import { recordNotification } from '@/stores/notification-center-store';
import { confirmGroups, useConfirmedGroups } from '@/lib/plugin-sandbox/account-kind';
import { teamFor, type TeamRef } from '@/lib/team-mailboxes/team';
import { onMention, watchMentions, type MentionEvent } from '@/lib/team-mailboxes/mention-watcher';
import { openMailLink } from '@/lib/desktop/mail-links';
import { messageOfNote } from '@/lib/desktop/mention-notifications';
import { displayName } from './note-cards';

function teamsOf(clients: ReadonlyMap<string, IJMAPClient>, rawPolicy: Parameters<typeof teamFor>[3]): Array<{ ref: TeamRef; client: IJMAPClient }> {
  const out: Array<{ ref: TeamRef; client: IJMAPClient }> = [];
  for (const [loginId, client] of clients) {
    const own = client.getAccountId();
    const accounts = typeof client.getSharedAccounts === 'function' ? client.getSharedAccounts() : [];
    for (const account of accounts) {
      if (account.id === own) continue;
      const ref = teamFor(client, loginId, account.id, rawPolicy);
      if (ref) out.push({ ref, client });
    }
  }
  return out;
}

export function TeamMentionHost() {
  const t = useTranslations('team_mailboxes');
  const router = useRouter();
  const activeClient = useAuthStore((s) => s.client);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const rawPolicy = usePolicyStore((s) => s.rawPolicy);
  const groupsRevision = useConfirmedGroups((s) => s.revision);

  const clients = useMemo(() => {
    void activeClient; void activeAccountId;
    const all = useAuthStore.getState().getAllConnectedClients?.() ?? new Map<string, IJMAPClient>();
    const map = new Map<string, IJMAPClient>(all as Map<string, IJMAPClient>);
    if (activeClient && activeAccountId && !map.has(activeAccountId)) map.set(activeAccountId, activeClient);
    return map;
  }, [activeClient, activeAccountId]);

  // Which accounts are groups: asked once per client, outside render.
  useEffect(() => {
    for (const client of clients.values()) void confirmGroups(client);
  }, [clients]);

  useEffect(() => {
    void groupsRevision;
    watchMentions(teamsOf(clients, rawPolicy));
  }, [clients, rawPolicy, groupsRevision]);
  useEffect(() => () => watchMentions([]), []);

  useEffect(() => onMention((event: MentionEvent) => {
    const { ref, client, note } = event;
    const name = displayName(note.author);
    const subject = note.subject?.trim() ?? '';
    const title = subject ? t('mentioned_you', { name, subject }) : t('mentioned_you_hidden');
    const show = async () => {
      const id = await messageOfNote(client, ref, note);
      if (!id) return;
      const slot = useAccountStore.getState().accounts.find((a) => a.id === ref.loginId)?.cookieSlot;
      openMailLink(
        { kind: 'message', id, ...(slot !== undefined ? { slot } : {}), ownerAccountId: ref.accountId, note: note.id },
        undefined,
        (path) => router.push(path),
      );
    };
    toast.info(title, { action: { label: t('show'), onClick: () => { void show(); } } });
    recordNotification({ level: 'info', title, body: note.text ?? '' });
  }), [t, router]);

  return null;
}
