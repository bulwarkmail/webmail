import { afterEach, describe, expect, it } from 'vitest';
import type { Email } from '../jmap/types';
import type { IJMAPClient } from '../jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { listSelectionOf, MAX_LIST_SELECTION } from '../plugin-sandbox/assistant/b.list-selection';
import { snapshotHostFeatures } from '../plugin-sandbox/host-features';
import { SLOT_CATALOG } from '../plugin-slot-catalog';

const client = { getAccountId: () => 'acc1' } as unknown as IJMAPClient;
const other = { getAccountId: () => 'other' } as unknown as IJMAPClient;

const row = (id: string, stamp: Partial<Email> = {}) => ({ id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: {}, ...stamp } as unknown as Email);
const state = (emails: Email[], keys: string[], threads: [string, Email[]][] = []) => ({
  emails, selectedEmailKeys: new Set(keys), threadEmailsCache: new Map(threads),
});

afterEach(() => {
  useAuthStore.setState({ client: null });
  useEmailStore.setState({ emails: [], selectedEmailKeys: new Set(), viewingAccountId: null });
});

describe('listSelectionOf', () => {
  it('is null with fewer than two messages ticked', () => {
    expect(listSelectionOf(state([row('a'), row('b')], []), client)).toBeNull();
    expect(listSelectionOf(state([row('a'), row('b')], ['a']), client)).toBeNull();
  });

  it('names each message with its account, members of open conversations too', () => {
    const shared = row('s', { sourceAccountId: 'team' });
    const member = row('m');
    expect(listSelectionOf(state([row('a'), shared], ['a', 'team:s', 'm'], [['t', [member]]]), client)).toEqual({
      emails: [{ id: 'a', accountId: 'acc1' }, { id: 's', accountId: 'team' }, { id: 'm', accountId: 'acc1' }],
      total: 3,
    });
  });

  it('names at most 50 and counts them all', () => {
    const rows = Array.from({ length: 70 }, (_, i) => row(`e${i}`));
    const out = listSelectionOf(state(rows, rows.map((r) => r.id)), client)!;
    expect(out.emails).toHaveLength(MAX_LIST_SELECTION);
    expect(out.total).toBe(70);
  });

  it('leaves out rows of another connected login, which this login can not read', () => {
    useAuthStore.setState({ client, getClientForAccount: (id: string) => (id === 'login2' ? other : null) } as never);
    const foreign = row('x', { sourceClientAccountId: 'login2', sourceAccountId: 'acc-2' });
    expect(listSelectionOf(state([row('a'), foreign], ['a', 'login2/acc-2:x']), client)).toEqual({ emails: [{ id: 'a', accountId: 'acc1' }], total: 2 });
  });

  it('is announced and reaches only plugins that may read mail', () => {
    expect(snapshotHostFeatures()).toMatchObject({ listSelection: true });
    const spec = SLOT_CATALOG['email-detail-sidebar'];
    expect(spec.props === '*' ? null : spec.props.listSelection).toBe('email:read');
    // The panel outside Mail (area f) has no list to tick in.
    const app = SLOT_CATALOG['app-side-panel' as keyof typeof SLOT_CATALOG];
    if (app && app.props !== '*') expect(app.props).not.toHaveProperty('listSelection');
  });
});
