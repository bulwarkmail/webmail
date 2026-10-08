"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import type { Mailbox } from '@/lib/jmap/types';
import { getMailboxPath } from '@/lib/utils';
import {
  FolderChangedError,
  isSameAccount,
  migrateFolder,
  type FolderMigrationMode,
  type FolderMigrationProgress,
  type FolderMigrationResult,
} from '@/lib/folder-migration';
import { SettingsSection, SettingItem, Select, RadioGroup } from './settings-section';
import { Button } from '@/components/ui/button';

/** The account's own folders, fetched through its client; [] until loaded. */
function useAccountFolders(accountId: string): Mailbox[] {
  const [folders, setFolders] = useState<{ accountId: string; list: Mailbox[] }>({ accountId: '', list: [] });
  useEffect(() => {
    const client = accountId ? useAuthStore.getState().getClientForAccount(accountId) : undefined;
    if (!client) return;
    let cancelled = false;
    client.getMailboxes().then(
      (list) => { if (!cancelled) setFolders({ accountId, list: list.filter((mb) => !mb.isShared) }); },
      () => { if (!cancelled) setFolders({ accountId, list: [] }); },
    );
    return () => { cancelled = true; };
  }, [accountId]);
  return folders.accountId === accountId ? folders.list : [];
}

function folderOptions(folders: Mailbox[], usable: (mb: Mailbox) => boolean, placeholder: string) {
  return [
    { value: '', label: placeholder },
    ...folders
      .filter(usable)
      .map((mb) => ({ value: mb.id, label: getMailboxPath(mb, folders) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
}

/**
 * Copies or moves a whole folder into a folder of another connected account.
 * Only shown with at least two accounts connected.
 */
export function FolderMigrationSettings() {
  const t = useTranslations('folder_migration');
  const accounts = useAccountStore((s) => s.accounts);
  // Re-read the connected clients when background restoration finishes.
  const revision = useAuthStore((s) => s.connectedAccountsRevision);
  const connected = useMemo(() => {
    void revision;
    const clients = useAuthStore.getState().getAllConnectedClients();
    return accounts.filter((a) => clients.has(a.id));
  }, [accounts, revision]);

  const [sourceAccountId, setSourceAccountId] = useState('');
  const [sourceMailboxId, setSourceMailboxId] = useState('');
  const [destAccountId, setDestAccountId] = useState('');
  const [destMailboxId, setDestMailboxId] = useState('');
  const [mode, setMode] = useState<FolderMigrationMode>('copy');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<FolderMigrationProgress | null>(null);
  const [result, setResult] = useState<FolderMigrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const sourceFolders = useAccountFolders(sourceAccountId);
  const destFolders = useAccountFolders(destAccountId);

  if (connected.length < 2) return null;

  const accountOptions = [
    { value: '', label: t('choose_account') },
    ...connected.map((a) => ({ value: a.id, label: a.label || a.email || a.id })),
  ];
  const sourceClient = sourceAccountId ? useAuthStore.getState().getClientForAccount(sourceAccountId) : undefined;
  const destClient = destAccountId ? useAuthStore.getState().getClientForAccount(destAccountId) : undefined;
  const sameAccount = !!sourceClient && !!destClient && isSameAccount(sourceClient, destClient);
  const canStart = !running && !!sourceClient && !!destClient && !!sourceMailboxId && !!destMailboxId && !sameAccount;

  const start = async () => {
    if (!sourceClient || !destClient || !canStart) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setProgress(null);
    setResult(null);
    setError(null);
    try {
      const outcome = await migrateFolder({
        source: sourceClient,
        sourceMailboxId,
        destination: destClient,
        destMailboxId,
        mode,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setResult(outcome);
    } catch (err) {
      // Stopped while the folder was still being read: nothing was changed.
      if (!controller.signal.aborted) setError(err instanceof FolderChangedError ? t('folder_changed') : err instanceof Error ? err.message : String(err));
    } finally {
      abortRef.current = null;
      setRunning(false);
      // Folder counters of both accounts changed.
      const store = useEmailStore.getState();
      const activeAccountId = useAuthStore.getState().activeAccountId;
      for (const [id, client] of [[sourceAccountId, sourceClient], [destAccountId, destClient]] as const) {
        if (id === activeAccountId) void store.fetchMailboxes(client);
        else void store.fetchAccountMailboxes(client, id);
      }
    }
  };

  const shown = result ?? progress;

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <SettingItem label={t('source')}>
        <div className="flex flex-col gap-2 sm:items-end">
          <Select
            value={sourceAccountId}
            onChange={(v) => { setSourceAccountId(v); setSourceMailboxId(''); }}
            options={accountOptions}
            disabled={running}
            ariaLabel={t('source_account')}
          />
          <Select
            value={sourceMailboxId}
            onChange={setSourceMailboxId}
            options={folderOptions(sourceFolders, () => true, t('choose_folder'))}
            disabled={running || !sourceAccountId}
            ariaLabel={t('source_folder')}
          />
        </div>
      </SettingItem>

      <SettingItem label={t('destination')} description={sameAccount ? t('same_account') : undefined}>
        <div className="flex flex-col gap-2 sm:items-end">
          <Select
            value={destAccountId}
            onChange={(v) => { setDestAccountId(v); setDestMailboxId(''); }}
            options={accountOptions}
            disabled={running}
            ariaLabel={t('destination_account')}
          />
          <Select
            value={destMailboxId}
            onChange={setDestMailboxId}
            options={folderOptions(destFolders, (mb) => mb.myRights?.mayAddItems !== false, t('choose_folder'))}
            disabled={running || !destAccountId}
            ariaLabel={t('destination_folder')}
          />
        </div>
      </SettingItem>

      <SettingItem label={t('mode')} description={mode === 'move' ? t('move_hint') : t('copy_hint')}>
        <RadioGroup
          value={mode}
          onChange={(v) => { if (!running) setMode(v as FolderMigrationMode); }}
          options={[
            { value: 'copy', label: t('copy') },
            { value: 'move', label: t('move') },
          ]}
        />
      </SettingItem>

      <div className="flex items-center gap-3">
        {running ? (
          <Button variant="outline" size="sm" onClick={() => abortRef.current?.abort()}>
            {t('stop')}
          </Button>
        ) : (
          <Button size="sm" onClick={() => void start()} disabled={!canStart}>
            {t('start')}
          </Button>
        )}
        <div className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {running && !progress && t('reading')}
          {shown && (running || result) && (
            <span>{t('progress', { done: shown.done, total: shown.total })}</span>
          )}
          {result && !result.failure && (
            <span> {result.stopped ? t('stopped') : t('finished')}</span>
          )}
          {result && result.kept > 0 && (
            <span> {t('kept', { count: result.kept })}</span>
          )}
        </div>
      </div>

      {result?.failure && (
        <p className="text-sm text-destructive" role="alert">
          {result.failure.imported
            ? t('failed_after_import', { error: result.failure.message })
            : t('failed', { error: result.failure.message })}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">{error}</p>
      )}
    </SettingsSection>
  );
}
