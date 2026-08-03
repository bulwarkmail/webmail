import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../client';

// Non-exhaustive helpers to reach into the private state we care about
// (backoff counters, callbacks) without exposing them on the public surface.
interface ClientInternals {
  pingSkipRemaining: number;
  pingFailureCount: number;
  apiUrl: string;
  intentionallyDisconnected: boolean;
  connectionChangeCallback: ((connected: boolean) => void) | null;
  rateLimitedUntil: number;
}

function internals(client: JMAPClient): ClientInternals {
  return client as unknown as ClientInternals;
}

describe('JMAPClient.resumeConnectivity', () => {
  let client: JMAPClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = new JMAPClient('https://example.test', 'user@example.test', 'pw');
    // Simulate a fully connected client (apiUrl set by a prior connect()).
    internals(client).apiUrl = 'https://example.test/jmap';
    internals(client).pingSkipRemaining = 5;
    internals(client).pingFailureCount = 3;
  });

  it('fires the connection callback on a successful ping and resets backoff', async () => {
    const onChange = vi.fn();
    client.onConnectionChange(onChange);
    const pingSpy = vi.spyOn(client, 'ping').mockResolvedValue();
    const reconnectSpy = vi.spyOn(client, 'reconnect').mockResolvedValue();

    await client.resumeConnectivity();

    expect(pingSpy).toHaveBeenCalledOnce();
    expect(reconnectSpy).not.toHaveBeenCalled();
    // Backoff must be wiped so the next scheduled tick fires immediately if
    // things flip again — this is the whole point of the manual resume.
    expect(internals(client).pingSkipRemaining).toBe(0);
    expect(internals(client).pingFailureCount).toBe(0);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('falls through to reconnect() when the ping throws', async () => {
    const onChange = vi.fn();
    client.onConnectionChange(onChange);
    vi.spyOn(client, 'ping').mockRejectedValue(new Error('boom'));
    const reconnectSpy = vi.spyOn(client, 'reconnect').mockResolvedValue();

    await client.resumeConnectivity();

    expect(reconnectSpy).toHaveBeenCalledOnce();
    expect(internals(client).pingFailureCount).toBe(0);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it('goes straight to reconnect() when apiUrl is empty (never connected)', async () => {
    internals(client).apiUrl = '';
    const pingSpy = vi.spyOn(client, 'ping').mockResolvedValue();
    const reconnectSpy = vi.spyOn(client, 'reconnect').mockResolvedValue();

    await client.resumeConnectivity();

    expect(pingSpy).not.toHaveBeenCalled();
    expect(reconnectSpy).toHaveBeenCalledOnce();
  });

  it('is a no-op after intentional disconnect', async () => {
    internals(client).intentionallyDisconnected = true;
    const pingSpy = vi.spyOn(client, 'ping').mockResolvedValue();
    const reconnectSpy = vi.spyOn(client, 'reconnect').mockResolvedValue();

    await client.resumeConnectivity();

    expect(pingSpy).not.toHaveBeenCalled();
    expect(reconnectSpy).not.toHaveBeenCalled();
  });

  it('is a no-op while rate-limited', async () => {
    internals(client).rateLimitedUntil = Date.now() + 60_000;
    const pingSpy = vi.spyOn(client, 'ping').mockResolvedValue();
    const reconnectSpy = vi.spyOn(client, 'reconnect').mockResolvedValue();

    await client.resumeConnectivity();

    expect(pingSpy).not.toHaveBeenCalled();
    expect(reconnectSpy).not.toHaveBeenCalled();
  });

  it('keeps quiet when both ping and reconnect fail (banner state stays)', async () => {
    const onChange = vi.fn();
    client.onConnectionChange(onChange);
    vi.spyOn(client, 'ping').mockRejectedValue(new Error('ping down'));
    vi.spyOn(client, 'reconnect').mockRejectedValue(new Error('reconnect down'));

    // Should not throw — the caller (visibilitychange handler) has nothing
    // useful to do with the error.
    await expect(client.resumeConnectivity()).resolves.toBeUndefined();

    // Never claim a successful re-establishment.
    expect(onChange).not.toHaveBeenCalledWith(true);
  });
});
