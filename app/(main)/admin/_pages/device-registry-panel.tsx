'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trash2, X } from '@/components/icons';
import { AdminList, AdminListRow } from '@/components/admin/list';
import { Badge } from '@/components/admin/badge';
import { SettingsSection } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { apiFetch } from '@/lib/browser-navigation';
import type { DeviceView } from '@/lib/devices/types';

const PAGE_SIZE = 100;

type Pending =
  | { kind: 'device'; device: DeviceView }
  | { kind: 'user'; userKey: string; user: string; count: number }
  | { kind: 'forget'; device: DeviceView };

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '';
}

/**
 * Browsers with offline mode on and desktop apps. A wipe waits for the device's
 * next contact, and the row says so until the device confirms. Its own section,
 * with no draft and no save bar: each action happens when it's confirmed.
 */
export function DeviceRegistryPanel() {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE) });
      if (search) params.set('q', search);
      const res = await apiFetch(`/api/admin/devices?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { devices: DeviceView[]; total: number };
      setDevices(data.devices);
      setTotal(data.total);
      setError(null);
    } catch (e) {
      setError(`Could not load the devices (${(e as Error).message})`);
    }
  }, [offset, search]);

  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    try {
      const res = await apiFetch('/api/admin/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(`That didn't work (${(e as Error).message})`);
    } finally {
      setBusy(null);
    }
  };

  const groups = useMemo(() => {
    const byUser = new Map<string, DeviceView[]>();
    for (const device of devices ?? []) {
      const rows = byUser.get(device.userKey) ?? [];
      rows.push(device);
      byUser.set(device.userKey, rows);
    }
    return [...byUser.entries()].map(([userKey, rows]) => ({
      userKey,
      user: rows[0].user,
      server: rows[0].server,
      rows: [...rows].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
    }));
  }, [devices]);

  const confirmPending = () => {
    if (!pending) return;
    setPending(null);
    if (pending.kind === 'device') void act(pending.device.id, { action: 'wipe', id: pending.device.id });
    else if (pending.kind === 'forget') void act(pending.device.id, { action: 'forget', id: pending.device.id });
    else void act(pending.userKey, { action: 'wipe-user', userKey: pending.userKey });
  };

  return (
    <SettingsSection
      id="registered"
      title="Registered devices"
      description="Browsers with offline mode on and desktop apps. A wipe deletes the mail, keys and files kept on the device and signs the account out the next time the device reaches this instance. A device that was signed out or had its browser data cleared has nothing left, and can't confirm: its row keeps saying the wipe is waiting."
    >
      <form
        className="flex flex-wrap items-center gap-2 pb-3"
        onSubmit={(event) => { event.preventDefault(); setOffset(0); setSearch(query.trim()); }}
      >
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by user"
          aria-label="Search by user"
          className="h-8 min-w-48 flex-1 rounded-md border border-input bg-background px-2 text-sm"
          data-testid="devices-search"
        />
        <Button type="submit" variant="outline" size="sm" className="h-8 text-xs">Search</Button>
      </form>
      {error && <p className="pb-3 text-sm text-destructive" role="alert">{error}</p>}
      {devices !== null && devices.length === 0 && (
        <p className="py-3 text-sm text-muted-foreground" data-testid="devices-empty">
          {search ? 'No device matches that search.' : 'No device has registered yet.'}
        </p>
      )}
      <div className="space-y-4">
        {groups.map((group) => {
          const wipeable = group.rows.filter((device) => !device.wipe && !device.wipedAt);
          return (
            <div key={group.userKey} data-testid="devices-user" data-user={group.user}>
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                <p className="min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                  {group.user}
                  <span className="ms-2 text-xs font-normal text-muted-foreground">{group.server}</span>
                </p>
                {wipeable.length > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    disabled={busy === group.userKey}
                    onClick={() => setPending({ kind: 'user', userKey: group.userKey, user: group.user, count: wipeable.length })}
                    data-testid="devices-wipe-user"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Wipe all {wipeable.length} devices
                  </Button>
                )}
              </div>
              <AdminList>
                {group.rows.map((device) => (
                  <AdminListRow
                    key={device.id}
                    data-testid="device-row"
                    title={device.platform || 'Unknown device'}
                    titleExtra={device.wipe
                      ? <Badge tone="warning">Wipe waiting</Badge>
                      : device.wipedAt
                        ? <Badge tone="muted">Wiped</Badge>
                        : null}
                    description={device.wipe
                      ? `Asked ${when(device.wipe.requestedAt)}. Happens the next time this device connects.`
                      : device.wipedAt
                        ? `Wiped ${when(device.wipedAt)}${device.wipeReason && device.wipeReason !== 'admin' ? ` (${wipeReasonLabel(device.wipeReason)})` : ''}`
                        : undefined}
                    meta={`${device.appVersion ? `Version ${device.appVersion} · ` : ''}Last seen ${when(device.lastSeen)} · First seen ${when(device.firstSeen)}`}
                    control={(
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {!device.wipe && !device.wipedAt && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5 text-xs"
                            disabled={busy === device.id}
                            onClick={() => setPending({ kind: 'device', device })}
                            data-testid="device-wipe"
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Wipe
                          </Button>
                        )}
                        {device.wipe && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5 text-xs"
                            disabled={busy === device.id}
                            onClick={() => { void act(device.id, { action: 'cancel', id: device.id }); }}
                            data-testid="device-cancel"
                          >
                            <X className="h-3.5 w-3.5" /> Take back
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs text-muted-foreground"
                          disabled={busy === device.id}
                          onClick={() => setPending({ kind: 'forget', device })}
                          data-testid="device-forget"
                        >
                          Forget
                        </Button>
                      </div>
                    )}
                  />
                ))}
              </AdminList>
            </div>
          );
        })}
      </div>
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 pt-3 text-xs text-muted-foreground">
          <span>{offset + 1} to {Math.min(offset + PAGE_SIZE, total)} of {total}</span>
          <span className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</Button>
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</Button>
          </span>
        </div>
      )}
      <ConfirmDialog
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmPending}
        title={pending?.kind === 'forget' ? 'Forget this device?' : 'Wipe this data?'}
        message={confirmMessage(pending)}
        confirmText={pending?.kind === 'forget' ? 'Forget' : 'Wipe'}
        variant="destructive"
      />
    </SettingsSection>
  );
}

function wipeReasonLabel(reason: NonNullable<DeviceView['wipeReason']>): string {
  switch (reason) {
    case 'user': return 'by the user';
    case 'rejected': return 'the server refused the login';
    default: return reason;
  }
}

function confirmMessage(pending: Pending | null): string {
  if (!pending) return '';
  const consequences = 'Mail, keys and files kept on it are deleted and the account is signed out the next time it connects. Mail that was waiting to be sent is lost. S/MIME and OpenPGP keys imported in that browser or app go for every account there, because they are not kept per account: anyone using them has to import them again. Keys in the OS certificate store stay. The mail on the server is not touched.';
  if (pending.kind === 'device') return `${pending.device.platform || 'This device'} of ${pending.device.user}. ${consequences}`;
  if (pending.kind === 'user') return `All ${pending.count} devices of ${pending.user}. ${consequences}`;
  return pending.device.wipe
    ? `The wipe waiting for ${pending.device.platform || 'this device'} of ${pending.device.user} is dropped with its row. The device will not be told.`
    : `${pending.device.platform || 'This device'} of ${pending.device.user} leaves this list. It comes back as a new row if it registers again.`;
}
