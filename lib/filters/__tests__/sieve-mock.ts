import { vi } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { SieveScript } from '@/lib/jmap/sieve-types';

/**
 * An in-memory Sieve account behind a mock client. Every call names the
 * account it acts on, and a call for any other account throws, so a test
 * sees a write that went to the wrong script.
 */
export function mockSieveAccount(
  accountId: string,
  initial: Array<{ id?: string; name: string; content: string; isActive: boolean }> = [],
  extensions: string[] = ['fileinto', 'mailbox', 'mailboxid', 'imap4flags', 'include', 'copy', 'spamtestplus', 'relational'],
) {
  let nextId = 1;
  let nextBlob = 1;
  const blobs = new Map<string, string>();
  const scripts: SieveScript[] = initial.map((s) => {
    const blobId = `blob-${nextBlob++}`;
    blobs.set(blobId, s.content);
    return { id: s.id ?? `script-${nextId++}`, name: s.name, blobId, isActive: s.isActive };
  });
  const own = (acct: string | undefined) => {
    if (acct !== accountId) throw new Error(`call for account ${acct} reached account ${accountId}`);
  };
  const setActive = (id: string | null) => {
    for (const s of scripts) s.isActive = s.id === id;
  };

  const client = {
    getAccountId: () => accountId,
    getSieveAccountId: () => accountId,
    getSieveCapabilities: (acct?: string) => { own(acct); return { sieveExtensions: extensions } as never; },
    getSieveScripts: vi.fn(async (acct?: string) => { own(acct); return scripts.map((s) => ({ ...s })); }),
    getSieveScriptContent: vi.fn(async (blobId: string, acct?: string) => { own(acct); return blobs.get(blobId) ?? ''; }),
    updateSieveScript: vi.fn(async (id: string, content: string, activate?: boolean, acct?: string) => {
      own(acct);
      const script = scripts.find((s) => s.id === id);
      if (!script) throw new Error('notFound');
      const blobId = `blob-${nextBlob++}`;
      blobs.set(blobId, content);
      script.blobId = blobId;
      if (activate) setActive(id);
    }),
    createSieveScript: vi.fn(async (name: string, content: string, activate?: boolean, acct?: string) => {
      own(acct);
      const blobId = `blob-${nextBlob++}`;
      blobs.set(blobId, content);
      const script = { id: `script-${nextId++}`, name, blobId, isActive: false };
      scripts.push(script);
      if (activate) setActive(script.id);
      return { ...script };
    }),
    deleteSieveScript: vi.fn(async (id: string, acct?: string) => {
      own(acct);
      const index = scripts.findIndex((s) => s.id === id);
      if (scripts[index]?.isActive) throw new Error('scriptIsActive');
      scripts.splice(index, 1);
    }),
    activateSieveScript: vi.fn(async (id: string, acct?: string) => { own(acct); setActive(id); }),
    deactivateSieveScript: vi.fn(async (acct?: string) => { own(acct); setActive(null); }),
    queryEmailFields: vi.fn(async () => [] as Array<Record<string, unknown>>),
    batchUpdateKeywords: vi.fn(async () => {}),
  };

  return {
    client: client as unknown as IJMAPClient & typeof client,
    scripts,
    /** The content of the named script, or of the active one. */
    content(name?: string): string {
      const script = name ? scripts.find((s) => s.name === name) : scripts.find((s) => s.isActive);
      return script ? blobs.get(script.blobId) ?? '' : '';
    },
    active(): string | null {
      return scripts.find((s) => s.isActive)?.name ?? null;
    },
    writes(): number {
      return client.updateSieveScript.mock.calls.length + client.createSieveScript.mock.calls.length
        + client.deleteSieveScript.mock.calls.length;
    },
  };
}
