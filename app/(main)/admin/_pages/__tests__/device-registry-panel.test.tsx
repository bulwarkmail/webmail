import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceView } from '@/lib/devices/types';
import { DeviceRegistryPanel } from '../device-registry-panel';

const device = (over: Partial<DeviceView>): DeviceView => ({
  id: `${'a'.repeat(64)}/${'b'.repeat(32)}`,
  userKey: 'a'.repeat(64),
  user: 'alice@example.org',
  server: 'https://mail.example.org',
  platform: 'Chrome, Windows',
  appVersion: '1.2.3',
  firstSeen: '2026-11-01T10:00:00.000Z',
  lastSeen: '2026-11-03T10:00:00.000Z',
  wipe: null,
  wipedAt: null,
  wipeReason: null,
  ...over,
});

let rows: DeviceView[];
let posts: Array<Record<string, unknown>>;

beforeEach(() => {
  posts = [];
  rows = [device({})];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    }
    expect(String(input)).toContain('/api/admin/devices');
    return new Response(JSON.stringify({ devices: rows, total: rows.length }), { status: 200 });
  }));
});

describe('the registered devices', () => {
  it('lists user, platform, version and last seen', async () => {
    render(<DeviceRegistryPanel />);
    const row = await screen.findByTestId('device-row');
    expect(screen.getByText('alice@example.org')).toBeTruthy();
    expect(row.textContent).toContain('Chrome, Windows');
    expect(row.textContent).toContain('Version 1.2.3');
    expect(row.textContent).toContain('Last seen');
  });

  it('wipes only after the confirmation, naming who and what', async () => {
    render(<DeviceRegistryPanel />);
    fireEvent.click(await screen.findByTestId('device-wipe'));
    expect(posts).toEqual([]);
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.getByRole('dialog'));
    expect(dialog.textContent).toContain('alice@example.org');
    expect(dialog.textContent).toContain('Mail that was waiting to be sent is lost');
    expect(dialog.textContent).toContain('S/MIME and OpenPGP keys imported in that browser or app go for every account there');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Wipe' }));
    await waitFor(() => expect(posts).toEqual([{ action: 'wipe', id: rows[0].id }]));
  });

  it('offers all of a user\'s devices once there are several', async () => {
    rows = [device({}), device({ id: `${'a'.repeat(64)}/${'c'.repeat(32)}`, platform: 'Desktop app, Windows' })];
    render(<DeviceRegistryPanel />);
    fireEvent.click(await screen.findByTestId('devices-wipe-user'));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.getByRole('dialog'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Wipe' }));
    await waitFor(() => expect(posts).toEqual([{ action: 'wipe-user', userKey: 'a'.repeat(64) }]));
  });

  it('says a wipe is waiting and lets the admin take it back', async () => {
    rows = [device({ wipe: { requestedAt: '2026-11-03T11:00:00.000Z', by: 'admin' } })];
    render(<DeviceRegistryPanel />);
    const row = await screen.findByTestId('device-row');
    expect(row.textContent).toContain('Wipe waiting');
    expect(screen.queryByTestId('device-wipe')).toBeNull();
    fireEvent.click(screen.getByTestId('device-cancel'));
    await waitFor(() => expect(posts).toEqual([{ action: 'cancel', id: rows[0].id }]));
  });

  it('shows a wiped device as such, with nothing more to wipe', async () => {
    rows = [device({ wipedAt: '2026-11-03T12:00:00.000Z', wipeReason: 'user' })];
    render(<DeviceRegistryPanel />);
    const row = await screen.findByTestId('device-row');
    expect(row.textContent).toContain('Wiped');
    expect(row.textContent).toContain('by the user');
    expect(screen.queryByTestId('device-wipe')).toBeNull();
    expect(screen.getByTestId('device-forget')).toBeTruthy();
  });

  it('says so when nothing registered', async () => {
    rows = [];
    render(<DeviceRegistryPanel />);
    expect(await screen.findByTestId('devices-empty')).toBeTruthy();
  });
});
