/**
 * A real JMAPClient talking to a FakeCalendarJmap while "online" and to the
 * store's answers while "offline", through a stubbed fetch.
 */

import { vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { setOfflineHooks, type OfflineMethodCall, type OfflineResponse } from '@/lib/jmap/offline-hooks';
import { DEFAULT_SCOPE, type StoreArea } from '../../area';
import { AccountEngine } from '../../engine/account-engine';
import { TransportError, type MethodCall } from '../../engine/transport';
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
    restore: () => {
      spy.mockRestore();
      setOfflineHooks(null);
    },
  };
  spy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.body) return json(CLIENT_SESSION);
    const calls = (JSON.parse(String(init.body)) as { methodCalls: MethodCall[] }).methodCalls;
    state.sent.push(...calls);
    if (!state.online) throw new TypeError('Failed to fetch');
    try {
      return json(await server.request(calls));
    } catch (error) {
      if (error instanceof TransportError && error.kind === 'network') throw new TypeError('Failed to fetch');
      throw error;
    }
  });
  setOfflineHooks({
    skipNetwork: () => !state.online,
    answer: async (_client, calls: OfflineMethodCall[]) => {
      state.sent.push(...calls);
      return engine.answer(calls) as Promise<OfflineResponse | null>;
    },
    record: () => {},
    noteNetwork: () => {},
    serverGone: async () => true,
    blob: async () => null,
    recordBlob: () => {},
    holdUpload: async () => null,
    resolveStandIns: (_client, ids) => engine.areaCall('calendar.resolveStandIns', { ids }) as Promise<Record<string, string | null>>,
  });
  return state;
}
