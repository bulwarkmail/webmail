import { describe, it, expect } from 'vitest';
import { parseJmapServers, redactJmapServers } from '@/lib/admin/jmap-servers';

describe('jmap server connectUrl', () => {
  it('keeps a valid https connect page, drops junk, and exposes it publicly', () => {
    const parsed = parseJmapServers([
      { id: 'bridge', label: 'Bridge', url: 'https://bridge.example.com', connectUrl: ' https://bridge.example.com/auth/google/start ' },
      { id: 'plain', label: 'Plain', url: 'https://mail.example.com', connectUrl: 'javascript:alert(1)' },
      { id: 'none', label: 'None', url: 'https://other.example.com' },
    ]);
    expect(parsed.map((s) => s.connectUrl)).toEqual(['https://bridge.example.com/auth/google/start', undefined, undefined]);
    const pub = redactJmapServers(parsed);
    expect(pub[0]!.connectUrl).toBe('https://bridge.example.com/auth/google/start');
    expect('connectUrl' in pub[1]!).toBe(false);
  });
});
