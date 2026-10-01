import { describe, expect, it, vi } from 'vitest';
import { reconcilePushBindings, releasePushBindings, type PushBinding, type PushRole } from '../push-bindings';

/** A client that counts what the reconciliation does to it. */
class FakeClient {
  setups = 0;
  closes = 0;
  sse = false;
  roles: PushRole[] = [];
  constructor(readonly name: string, private readonly slots: { free: number }) {}
  setupPushNotifications() {
    this.setups++;
    if (this.slots.free > 0) { this.slots.free--; this.sse = true; }
  }
  closePushNotifications() {
    this.closes++;
    if (this.sse) { this.slots.free++; this.sse = false; }
  }
  hasSSEStream() { return this.sse; }
}

function world(names: string[], freeSlots = 2) {
  const slots = { free: freeSlots };
  const clients = new Map(names.map((n) => [n, new FakeClient(n, slots)] as const));
  const bindings = new Map<FakeClient, PushBinding>();
  const run = (connected: string[], active: string | null) => reconcilePushBindings({
    bindings,
    clients: new Map(connected.map((n) => [n, clients.get(n)!] as const)),
    activeAccountId: active,
    listen: (c, role) => { c.roles.push(role); },
  });
  return { clients, bindings, run, slots };
}

describe('reconcilePushBindings', () => {
  it('binds each login once however many times the effect re-runs while logins connect', () => {
    const { clients, run } = world(['a', 'b', 'c', 'd']);
    // A restore: the effect runs once per login that connects.
    run(['a'], 'a');
    run(['a', 'b'], 'a');
    run(['a', 'b', 'c'], 'a');
    run(['a', 'b', 'c', 'd'], 'a');
    run(['a', 'b', 'c', 'd'], 'a');
    for (const c of clients.values()) {
      expect(c.setups, c.name).toBe(1);
      expect(c.closes, c.name).toBe(0);
    }
  });

  it('gives the active login a live stream before the background ones', () => {
    const { clients, run } = world(['a', 'b', 'c'], 1);
    run(['b', 'c', 'a'], 'a');
    expect(clients.get('a')!.hasSSEStream()).toBe(true);
    expect(clients.get('b')!.hasSSEStream()).toBe(false);
  });

  it('unbinds only the login that went away', () => {
    const { clients, bindings, run } = world(['a', 'b', 'c']);
    run(['a', 'b', 'c'], 'a');
    run(['a', 'c'], 'a');
    expect(clients.get('b')!.closes).toBe(1);
    expect(clients.get('a')!.closes).toBe(0);
    expect(clients.get('c')!.closes).toBe(0);
    expect([...bindings.values()].map((b) => b.accountId).sort()).toEqual(['a', 'c']);
  });

  it('on an account switch touches only the two logins whose role changed', () => {
    const { clients, run } = world(['a', 'b', 'c', 'd'], 1);
    run(['a', 'b', 'c', 'd'], 'a');
    const setupsBefore = [...clients.values()].map((c) => c.setups);
    run(['a', 'b', 'c', 'd'], 'c');
    // c had no stream: it takes a's, and a is re-bound as background.
    expect(clients.get('c')!.hasSSEStream()).toBe(true);
    expect(clients.get('c')!.roles.at(-1)).toBe('active');
    expect(clients.get('a')!.roles.at(-1)).toBe('background');
    expect(clients.get('b')!.setups).toBe(setupsBefore[1]);
    expect(clients.get('d')!.setups).toBe(setupsBefore[3]);
  });

  it('only swaps the callback when the newly active login already has a stream', () => {
    const { clients, run } = world(['a', 'b'], 2);
    run(['a', 'b'], 'a');
    run(['a', 'b'], 'b');
    expect(clients.get('b')!.setups).toBe(1);
    expect(clients.get('b')!.roles).toEqual(['background', 'active']);
    expect(clients.get('a')!.roles).toEqual(['active', 'background']);
  });

  it('rebinds a login whose client was replaced', () => {
    const { bindings, run, clients } = world(['a']);
    run(['a'], 'a');
    const old = clients.get('a')!;
    const fresh = new FakeClient('a', { free: 2 });
    reconcilePushBindings({
      bindings, clients: new Map([['a', fresh]]), activeAccountId: 'a', listen: vi.fn(),
    });
    expect(old.closes).toBe(1);
    expect(fresh.setups).toBe(1);
  });

  it('releases everything on logout', () => {
    const { clients, bindings, run } = world(['a', 'b']);
    run(['a', 'b'], 'a');
    releasePushBindings(bindings);
    expect(bindings.size).toBe(0);
    for (const c of clients.values()) expect(c.closes).toBe(1);
  });
});
