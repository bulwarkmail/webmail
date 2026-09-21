'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { evictAccount } from '@/lib/account-state-manager';
import { collectTransferMessages, transferMessages, type TransferMessage, type TransferProgress } from '@/lib/email-transfer';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { Button } from '@/components/ui/button';

export function resolveTransferSelection(emails: Email[]): TransferMessage[] {
  const auth = useAuthStore.getState();
  const state = useEmailStore.getState();
  const viewingId = state.viewingAccountId ?? auth.activeAccountId;
  const mailboxes = state.viewingAccountId ? state.accountMailboxes[state.viewingAccountId] ?? [] : state.mailboxes;
  const mailbox = mailboxes.find(m => m.id === state.selectedMailbox);
  const resolved = emails.map(email => {
    const localAccountId = email.sourceClientAccountId ?? viewingId;
    const client = localAccountId ? auth.getClientForAccount(localAccountId) : undefined;
    if (!client || !localAccountId) throw new Error('The source account is disconnected.');
    return { id: email.id, client, localAccountId,
      accountId: email.sourceAccountId ?? (mailbox?.isShared ? mailbox.accountId : undefined) ?? client.getAccountId() };
  });
  return [...new Map(resolved.map(message => [
    JSON.stringify([message.localAccountId, message.accountId, message.id]), message,
  ])).values()];
}

export function AccountTransferDialog({ selection, onClose }: { selection?: TransferMessage[]; onClose: () => void }) {
  const t = useTranslations('account_transfer');
  const id = useId();
  const accounts = useAccountStore(s => s.accounts);
  const activeId = useAuthStore(s => s.activeAccountId);
  const [sourceId, setSourceId] = useState(selection?.[0]?.localAccountId ?? activeId ?? '');
  const [destinationId, setDestinationId] = useState('');
  const [sourceFolder, setSourceFolder] = useState('');
  const [targetFolder, setTargetFolder] = useState('');
  const [sourceFolders, setSourceFolders] = useState<Mailbox[]>([]);
  const [targetFolders, setTargetFolders] = useState<Mailbox[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [targetLoading, setTargetLoading] = useState(false);
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [prepared, setPrepared] = useState<TransferMessage[] | null>(null);
  const [running, setRunning] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const busy = running || preparing;
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  const dialogRef = useFocusTrap({ isActive: true, onEscape: close });
  const excluded = new Set(selection?.map(m => m.localAccountId) ?? [sourceId]);
  const source = accounts.find(a => a.id === sourceId);
  const destination = accounts.find(a => a.id === destinationId);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  useEffect(() => {
    if (selection) return;
    let cancelled = false;
    setSourceLoading(true);
    setSourceFolders([]);
    setSourceFolder('');
    const client = useAuthStore.getState().getClientForAccount(sourceId);
    if (!client) { setSourceLoading(false); return; }
    client.getMailboxes().then(folders => {
      if (!cancelled) setSourceFolders(folders.filter(m => !m.isShared));
    }).catch(() => { if (!cancelled) setError(t('folders_error')); })
      .finally(() => { if (!cancelled) setSourceLoading(false); });
    return () => { cancelled = true; };
  }, [sourceId, selection, t]);

  useEffect(() => {
    let cancelled = false;
    setTargetFolder('');
    setTargetFolders([]);
    setTargetLoading(true);
    const client = useAuthStore.getState().getClientForAccount(destinationId);
    if (!client) { setTargetLoading(false); return; }
    client.getMailboxes().then(folders => {
      if (cancelled) return;
      const writable = folders.filter(m => !m.isShared && m.myRights?.mayAddItems !== false);
      setTargetFolders(writable);
      setTargetFolder(writable.find(m => m.role === 'inbox')?.id ?? writable[0]?.id ?? '');
    }).catch(() => { if (!cancelled) setError(t('folders_error')); })
      .finally(() => { if (!cancelled) setTargetLoading(false); });
    return () => { cancelled = true; };
  }, [destinationId, t]);

  const prepare = async () => {
    setError('');
    setPreparing(true);
    setStopping(false);
    controller.current = new AbortController();
    try {
      const client = useAuthStore.getState().getClientForAccount(sourceId);
      if (!client && !selection) throw new Error(t('disconnected'));
      const messages = selection ?? await collectTransferMessages(client!, sourceId, sourceFolder || undefined, controller.current.signal);
      if (!messages.length) throw new Error(t('empty'));
      setPrepared(messages);
    } catch (e) { if (!controller.current.signal.aborted) setError(e instanceof Error ? e.message : t('failed')); }
    finally { setPreparing(false); }
  };

  const start = async () => {
    if (!prepared || busy) return;
    const destinationClient = useAuthStore.getState().getClientForAccount(destinationId);
    if (!destinationClient) { setError(t('disconnected')); return; }
    setError('');
    setRunning(true);
    setStopping(false);
    controller.current = new AbortController();
    try {
      const result = await transferMessages({ messages: prepared, destination: destinationClient,
        mailboxId: targetFolder, mode, signal: controller.current.signal, onProgress: setProgress });
      setProgress(result);
      // A move can fail after copying; report it explicitly, never repeat it automatically.
      if (result.failure) setError(t(result.failure.copied ? 'delete_failed' : 'transfer_failed', {
        id: result.failure.emailId, reason: result.failure.message,
      }));
    } catch (e) { setError(e instanceof Error ? e.message : t('failed')); }
    finally {
      setRunning(false);
      setFinished(true);
      for (const accountId of new Set([...prepared.map(m => m.localAccountId), destinationId])) evictAccount(accountId);
      const auth = useAuthStore.getState();
      if (auth.client) {
        const store = useEmailStore.getState();
        store.clearSelection();
        void store.fetchMailboxes(auth.client);
        void store.fetchEmails(auth.client);
      }
    }
  };
  const selectClass = 'mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm';
  return createPortal(<div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-background p-6 text-foreground shadow-xl space-y-4">
      <h2 id={`${id}-title`} className="text-lg font-semibold">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <fieldset disabled={busy || !!prepared} className="space-y-3 disabled:opacity-70">
        {selection ? <p className="text-sm">{t('selected', { count: selection.length })}</p> : <>
          <label className="block text-sm">{t('source')}
            <select className={selectClass} value={sourceId} onChange={e => { setSourceId(e.target.value); setDestinationId(''); setError(''); }}>
              {accounts.map(a => <option key={a.id} value={a.id} disabled={!a.isConnected}>{a.email || a.username}{!a.isConnected ? ` (${t('offline')})` : ''}</option>)}
            </select>
          </label>
          <label className="block text-sm">{t('source_folder')}
            <select className={selectClass} value={sourceFolder} onChange={e => setSourceFolder(e.target.value)} disabled={sourceLoading}>
              <option value="">{t('all_mail')}</option>
              {sourceFolders.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        </>}
        <label className="block text-sm">{t('destination')}
          <select className={selectClass} value={destinationId} onChange={e => { setDestinationId(e.target.value); setError(''); }}>
            <option value="">{t('choose_account')}</option>
            {accounts.filter(a => !excluded.has(a.id)).map(a => <option key={a.id} value={a.id} disabled={!a.isConnected}>
              {a.email || a.username}{!a.isConnected ? ` (${t('offline')})` : ''}
            </option>)}
          </select>
        </label>
        <label className="block text-sm">{t('destination_folder')}
          <select className={selectClass} value={targetFolder} onChange={e => setTargetFolder(e.target.value)} disabled={targetLoading}>
            <option value="">{targetLoading ? t('loading') : t('choose_folder')}</option>
            {targetFolders.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <div className="flex gap-4 text-sm">
          {(['copy', 'move'] as const).map(value => <label key={value} className="flex items-center gap-2">
            <input type="radio" name={`${id}-mode`} checked={mode === value} onChange={() => setMode(value)} />{t(value)}
          </label>)}
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">{t(mode === 'move' ? 'move_description' : 'copy_description')}</p>
      {prepared && <p className="rounded-md bg-muted p-3 text-sm">{t('review', {
        count: prepared.length, source: selection ? t('selection') : source?.email || source?.username || '',
        destination: destination?.email || destination?.username || '', folder: targetFolders.find(m => m.id === targetFolder)?.name ?? '',
      })}</p>}
      {progress && <div role="status" aria-live="polite" className="space-y-2">
        <progress aria-label={t('progress_label')} className="w-full" max={progress.total || 1} value={progress.completed} />
        <p className="text-sm">{t('progress', { completed: progress.completed, total: progress.total, copied: progress.copied, moved: progress.moved })}</p>
        {finished && <p className="text-sm">{t(progress.completed === progress.total ? 'complete' : 'stopped')}</p>}
      </div>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {busy ? <Button variant="outline" disabled={stopping} onClick={() => { controller.current?.abort(); setStopping(true); }}>{t(stopping ? 'stopping' : 'stop')}</Button> : <>
          <Button variant="outline" onClick={close}>{t('close')}</Button>
          {!finished && (prepared ? <>
            <Button variant="outline" onClick={() => setPrepared(null)}>{t('back')}</Button>
            <Button onClick={() => void start()}>{t(mode === 'move' ? 'confirm_move' : 'confirm_copy')}</Button>
          </> : <Button disabled={!destinationId || !targetFolder || sourceLoading || targetLoading || (!selection && !source?.isConnected)}
            onClick={() => void prepare()}>{t('prepare')}</Button>)}
        </>}
      </div>
    </div>
  </div>, document.body);
}
