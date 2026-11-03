/**
 * A real JMAPClient talking to a FakeCalendarJmap while "online" and to the
 * store's answers while "offline", through a stubbed fetch.
 */

import { vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { DEFAULT_SCOPE, type StoreArea } from '../../area';
import { AccountEngine } from '../../engine/account-engine';
import type { MethodCall } from '../../engine/transport';
import { CALENDAR_SESSION, FakeCalendarJmap } from './fake-calendar';
import { JMAP_ACCOUNT } from './fake-jmap';
import { openMemoryStore } from './node-adapter';

const CLIENT_SESSION = {
  ...CALENDAR_SESSION,
  primaryAccounts: { ...CALENDAR_SESSION.primaryAccounts, 'urn:ietf:params:jmap:mail': JMAP_ACCOUNT },
  accounts: {
    [JMAP_ACCOUNT]: {
      name: 'a@example.org',
      isPersonal: true,
      accountCapabilities: { ...CALENDAR_SESSION.accounts[JMAP_ACCOUNT].accountCapabilities, 'urn:ietf:params:jmap:mail': {} },
    },
  },
  capabilities: { ...CALENDAR_SESSION.capabilities, 'urn:ietf:params:jmap:mail': {} },
  eventSourceUrl: '',
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export interface Wire {
  server: FakeCalendarJmap;
  engine: AccountEngine;
  db: ReturnType<typeof openMemoryStore>;
  /** Everything the client sent, wherever it went. */
  sent: MethodCall[];
  online: boolean;
  newClient(): Promise<JMAPClient>;
  restore(): void;
}

export function wire(server: FakeCalendarJmap, areas: readonly StoreArea[], now: number): Wire {
  const db = openMemoryStore();
  const engine = new AccountEngine({
    account: 'a@fake.test',
    db,
    session: CALENDAR_SESSION,
    transport: server,
    areas,
    scope: DEFAULT_SCOPE,
    now: () => now,
    sleep: async () => {},
  });
  const spy = vi.spyOn(globalThis, 'fetch');
  const state: Wire = {
    server,
    engine,
    db,
    sent: [],
    online: true,
    newClient: async () => {
      const client = new JMAPClient('https://fake.test', 'a@example.org', 'pw');
      await client.connect();
      return client;
    },
    restore: () => spy.mockRestore(),
  };
  spy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.body) return json(CLIENT_SESSION);
    const calls = (JSON.parse(String(init.body)) as { methodCalls: MethodCall[] }).methodCalls;
    state.sent.push(...calls);
    const answer = state.online ? await server.request(calls) : await engine.answer(calls);
    if (!answer) throw new TypeError('Failed to fetch');
    return json(answer);
  });
  return state;
}
