'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { getActiveAccountSlot } from '@/lib/auth/active-account-slot';
import { currentStoreEpoch } from '@/lib/store-epoch';
import { createMaskedEmailManager, maskedEmailErrorType, maskedEmailUnavailable, type MaskedAddress, type MaskedEmailManager } from '@/lib/stalwart/masked-email';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { SettingsSection } from './settings-section';

const PAGE_SIZE = 10;
type View = { context: MaskedEmailManager | null; status: 'loading' | 'ready' | 'forbidden' | 'unavailable' | 'error'; addresses: MaskedAddress[] };

function MaskedAddressRow({ address, expanded, busy, canUpdate, canDelete, onExpand, onUpdate, onDelete }: {
  address: MaskedAddress; expanded: boolean; busy: boolean; canUpdate: boolean; canDelete: boolean;
  onExpand: () => void;
  onUpdate: (id: string, changes: { description?: string; enabled?: boolean }) => Promise<boolean>;
  onDelete: (address: MaskedAddress) => Promise<void>;
}) {
  const t = useTranslations('settings.security.masked_addresses');
  const labelId = useId();
  const [description, setDescription] = useState(address.description ?? '');
  const [copyStatus, setCopyStatus] = useState<'copied' | 'copy_failed' | null>(null);
  useEffect(() => { setDescription(address.description ?? ''); }, [address.description, expanded]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(address.email); setCopyStatus('copied'); }
    catch { setCopyStatus('copy_failed'); }
  };
  return (
    <li>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_auto_auto] md:gap-3">
        <span className="min-w-0 flex-1 break-all text-sm font-medium md:truncate" title={address.email}>{address.email}</span>
        <div className="order-last flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground md:contents">
          <span className="min-w-0 max-w-full truncate md:text-sm" title={address.description || undefined}>{address.description || t('no_description')}</span>
          {/* Website metadata stays text, never an executable or loaded URL. */}
          <span className="min-w-0 max-w-full truncate" title={address.forDomain || undefined}>{address.forDomain || t('no_website')}</span>
          <span className={address.enabled ? 'text-foreground' : 'text-muted-foreground'}>{t(address.enabled ? 'enabled' : 'disabled')}</span>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" onClick={copy} aria-label={`${t('copy')} ${address.email}`}>{t('copy')}</Button>
          <Button size="sm" variant="outline" onClick={onExpand} disabled={busy} aria-expanded={expanded}
            aria-controls={`${labelId}-details`} aria-label={`${t(expanded ? 'close' : 'edit')} ${address.email}`}>{t(expanded ? 'close' : 'edit')}</Button>
        </div>
      </div>
      {copyStatus && <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">{t(copyStatus)}</p>}
      {expanded && <div id={`${labelId}-details`} className="space-y-3 border-t border-border bg-muted/30 px-3 py-3">
        <form className="flex flex-wrap items-end gap-2" onSubmit={async e => {
          e.preventDefault(); if (canUpdate) await onUpdate(address.id, { description });
        }}>
          <div className="min-w-0 flex-1">
            <label htmlFor={labelId} className="mb-1 block text-xs text-muted-foreground">{t('description')}</label>
            <Input id={labelId} value={description} disabled={busy || !canUpdate} onChange={e => setDescription(e.target.value)} />
          </div>
          <Button type="submit" size="sm" disabled={busy || !canUpdate || description === (address.description ?? '')}>{t('save')}</Button>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button size="sm" variant="outline" disabled={busy || !canUpdate}
            onClick={() => { void onUpdate(address.id, { enabled: !address.enabled }); }}
            aria-label={`${t(address.enabled ? 'disable' : 'enable')} ${address.email}`}>{t(address.enabled ? 'disable' : 'enable')}</Button>
          <Button size="sm" variant="destructive" disabled={busy || !canDelete} onClick={() => { void onDelete(address); }}
            aria-label={`${t('delete')} ${address.email}`}>{t('delete')}</Button>
        </div>
      </div>}
    </li>
  );
}

export function MaskedAddressesSection() {
  const t = useTranslations('settings.security.masked_addresses');
  const client = useAuthStore(s => s.client);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const slot = getActiveAccountSlot() ?? 0;
  const epoch = currentStoreEpoch();
  // The factory captures these store values, including equal native IDs on
  // different servers. All four must invalidate the captured context.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const context = useMemo(() => createMaskedEmailManager(), [client, activeAccountId, slot, epoch]);
  const [view, setView] = useState<View>({ context: null, status: 'loading', addresses: [] });
  // The account whose server answered the first read with anything but
  // "not supported". Until then the section stays hidden: most servers
  // (Stalwart Community) have no masked addresses.
  const [shownFor, setShownFor] = useState<MaskedEmailManager | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef<MaskedEmailManager | null>(null);
  const confirming = useRef<MaskedEmailManager | null>(null);
  const [canCreate, setCanCreate] = useState(true);
  const [canUpdate, setCanUpdate] = useState(true);
  const [canDelete, setCanDelete] = useState(true);
  const [deleteNeedsRefresh, setDeleteNeedsRefresh] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const labelId = useId();
  const { confirm, dialogProps } = useConfirmDialog();
  const closeConfirmation = dialogProps.onClose;
  useEffect(() => {
    let cancelled = false;
    closeConfirmation(); confirming.current = null; operation.current = null;
    setView({ context, status: 'loading', addresses: [] });
    setBusy(false); setCanCreate(true); setCanUpdate(true); setCanDelete(true); setDeleteNeedsRefresh(false);
    setExpandedId(null); setPage(0); setNotice(null); setDescription(''); setWebsite('');
    if (context) context.list().then(addresses => {
      if (!cancelled && context.isCurrent()) { setView({ context, status: 'ready', addresses }); setShownFor(context); }
    }).catch(error => {
      if (!cancelled && context.isCurrent()) {
        setView({ context, addresses: [], status:
          maskedEmailUnavailable(error) ? 'unavailable' : maskedEmailErrorType(error) === 'forbidden' ? 'forbidden' : 'error' });
        if (!maskedEmailUnavailable(error)) setShownFor(context);
      }
    });
    return () => { cancelled = true; };
  }, [context, closeConfirmation]);

  if (!context) return null;
  const current = view.context === context ? view : { context, status: 'loading', addresses: [] } as View;
  if (shownFor !== context) return null;
  const pageCount = Math.max(1, Math.ceil(current.addresses.length / PAGE_SIZE));
  const visiblePage = Math.min(page, pageCount - 1);
  const addressesOnPage = current.addresses.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE);
  const begin = () => {
    if (operation.current === context || !context.isCurrent()) return false;
    operation.current = context; setBusy(true); setNotice(null); return true;
  };
  const end = () => {
    if (operation.current === context) operation.current = null;
    if (context.isCurrent()) setBusy(false);
  };
  const load = async () => {
    try {
      const addresses = await context.list();
      if (!context.isCurrent()) return false;
      setView({ context, status: 'ready', addresses }); setShownFor(context);
      setPage(previous => Math.min(previous, Math.max(0, Math.ceil(addresses.length / PAGE_SIZE) - 1)));
      setExpandedId(previous => addresses.some(address => address.id === previous) ? previous : null);
      setDeleteNeedsRefresh(false); return true;
    } catch (error) {
      if (context.isCurrent()) setView({ context, addresses: [], status: maskedEmailUnavailable(error) ? 'unavailable' :
        maskedEmailErrorType(error) === 'forbidden' ? 'forbidden' : 'error' });
      return false;
    }
  };
  const refresh = async () => {
    if (!begin()) return;
    try { await load(); } finally { end(); }
  };
  const mutate = async (kind: 'create' | 'update' | 'destroy', action: () => Promise<unknown>): Promise<boolean> => {
    if (!begin()) return false;
    try { await action(); }
    catch (error) {
      if (context.isCurrent()) {
        const type = maskedEmailErrorType(error);
        if (type === 'forbidden') {
          if (kind === 'create') setCanCreate(false);
          else if (kind === 'update') setCanUpdate(false);
          else setCanDelete(false);
        }
        if (maskedEmailUnavailable(error)) setView({ context, addresses: [], status: 'unavailable' });
        if (kind === 'destroy') {
          setDeleteNeedsRefresh(type !== 'forbidden');
          setNotice(type === 'forbidden' ? 'delete_forbidden' : type === 'deleteUnconfirmed' ? 'delete_unconfirmed' : 'delete_failed');
        } else setNotice(type === 'forbidden' ? `${kind}_forbidden` : type === 'overQuota' ? 'over_quota' : type === 'rateLimit' ? 'rate_limit' : 'save_failed');
      }
      end(); return false;
    }
    if (!context.isCurrent()) { end(); return false; }
    if (kind === 'create') { setDescription(''); setWebsite(''); }
    if (kind === 'destroy') setExpandedId(null);
    // Only confirmed operations reach a refresh. Uncertain deletes require
    // an explicit read and another confirmation, never an automatic retry.
    try {
      const loaded = await load();
      if (context.isCurrent()) setNotice(kind === 'destroy' ? (loaded ? 'deleted' : 'deleted_refresh_failed') : 'saved');
      return true;
    } finally { end(); }
  };
  const destroy = async (address: MaskedAddress) => {
    if (!canDelete || deleteNeedsRefresh || operation.current === context || confirming.current || !context.isCurrent()) return;
    confirming.current = context;
    try {
      const accepted = await confirm({ title: t('delete_title'), message: t('delete_warning', { address: address.email }),
        confirmText: t('delete_confirm'), cancelText: t('cancel'), variant: 'destructive' });
      if (accepted && context.isCurrent()) await mutate('destroy', () => context.destroy(address.id));
    } finally { if (confirming.current === context) confirming.current = null; }
  };
  const changePage = (next: number) => { setPage(next); setExpandedId(null); };

  return <>
    <SettingsSection id="masked-addresses" title={t('title')} description={t('intro')}>
      <div className="space-y-4">
        {current.status === 'loading' && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}
        {current.status !== 'ready' && current.status !== 'loading' &&
          <p role="status" className="text-sm text-muted-foreground">{t(current.status === 'error' ? 'load_failed' : current.status)}</p>}
        {current.status === 'ready' && <>
          <p className="text-xs text-muted-foreground">{t('count', { count: current.addresses.length })}</p>
          {!current.addresses.length && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
          {!!current.addresses.length && <div className="min-w-0">
            <div aria-hidden="true" className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_auto_auto] gap-3 px-3 pb-1 text-xs text-muted-foreground md:grid">
              <span>{t('address')}</span><span>{t('description_column')}</span><span>{t('website_column')}</span><span>{t('state')}</span><span>{t('actions')}</span>
            </div>
            <ul className="divide-y divide-border rounded-md border border-border">
              {addressesOnPage.map(address => <MaskedAddressRow key={address.id} address={address} expanded={expandedId === address.id}
                busy={busy} canUpdate={canUpdate} canDelete={canDelete && !deleteNeedsRefresh}
                onExpand={() => setExpandedId(previous => previous === address.id ? null : address.id)}
                onUpdate={(id, changes) => mutate('update', () => context.update(id, changes))} onDelete={destroy} />)}
            </ul>
            {pageCount > 1 && <nav aria-label={t('pagination')} className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <Button size="sm" variant="outline" disabled={busy || visiblePage === 0} onClick={() => changePage(visiblePage - 1)}>{t('previous')}</Button>
              <span className="text-xs text-muted-foreground">{t('page', { page: visiblePage + 1, pages: pageCount })}</span>
              <Button size="sm" variant="outline" disabled={busy || visiblePage === pageCount - 1} onClick={() => changePage(visiblePage + 1)}>{t('next')}</Button>
            </nav>}
          </div>}
          {!canUpdate && <p role="status" className="text-sm text-muted-foreground">{t('update_forbidden')}</p>}
          {!canDelete && <p role="status" className="text-sm text-muted-foreground">{t('delete_forbidden')}</p>}
          <form className="space-y-3 border-t border-border pt-4" onSubmit={e => {
            e.preventDefault(); if (canCreate) void mutate('create', () => context.create({ description, forDomain: website }));
          }}>
            <h4 className="text-sm font-medium">{t('create')}</h4>
            <div>
              <label htmlFor={`${labelId}-website`} className="mb-1 block text-xs text-muted-foreground">{t('website')}</label>
              <Input id={`${labelId}-website`} value={website} onChange={e => setWebsite(e.target.value)} disabled={busy || !canCreate} />
            </div>
            <div>
              <label htmlFor={`${labelId}-description`} className="mb-1 block text-xs text-muted-foreground">{t('description')}</label>
              <Input id={`${labelId}-description`} value={description} onChange={e => setDescription(e.target.value)} disabled={busy || !canCreate} />
            </div>
            <Button type="submit" size="sm" disabled={busy || !canCreate}>{t('create')}</Button>
            {!canCreate && <p role="status" className="text-sm text-muted-foreground">{t('create_forbidden')}</p>}
          </form>
        </>}
        {notice && <p role="status" className="text-sm text-muted-foreground">{t(notice)}</p>}
        {current.status !== 'loading' && current.status !== 'unavailable' &&
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void refresh(); }}>{t('refresh')}</Button>}
      </div>
    </SettingsSection>
    <ConfirmDialog {...dialogProps} isOpen={dialogProps.isOpen && view.context === context && context.isCurrent()} />
  </>;
}
