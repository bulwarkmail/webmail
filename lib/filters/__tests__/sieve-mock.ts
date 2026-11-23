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
  options: { readOnly?: (name: string) => boolean } = {},
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
      if (options.readOnly?.(script.name)) throw new Error('forbidden');
      const blobId = `blob-${nextBlob++}`;
      blobs.set(blobId, content);
      script.blobId = blobId;
      if (activate) setActive(id);
    }),
    createSieveScript: vi.fn(async (name: string, content: string, activate?: boolean, acct?: string) => {
      own(acct);
      if (options.readOnly?.(name)) throw new Error('forbidden');
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
    /** The server writes a script of its own, outside the client; its activation stays. */
    put(name: string, content: string): SieveScript {
      const blobId = `blob-${nextBlob++}`;
      blobs.set(blobId, content);
      let script = scripts.find((s) => s.name === name);
      if (script) {
        script.blobId = blobId;
      } else {
        script = { id: `script-${nextId++}`, name, blobId, isActive: false };
        scripts.push(script);
      }
      return { ...script };
    },
  };
}

export const STALWART_VACATION_SCRIPT = 'require "vacation";\nvacation "Ich bin nicht da.";\n';

/**
 * A "vacation" script the way Stalwart up to 1.1 writes it from
 * VacationResponse/set (crates/jmap/src/vacation/set.rs, build_script): CRLF
 * lines, an `if currentdate` block for each date, the subject without line
 * breaks, the reply as a MIME body, backslashes and quotes escaped.
 */
export function stalwartVacationScript(reply: { fromDate?: string; toDate?: string; subject?: string; mimeBody: string }): string {
  const escape = (value: string) => value.replace(/[\\"]/g, (c) => `\\${c}`);
  let script = 'require ["vacation", "relational", "date"];\r\n\r\n';
  let blocks = 0;
  if (reply.fromDate) {
    script += `if currentdate :value "ge" "iso8601" "${reply.fromDate}" {\r\n`;
    blocks++;
  }
  if (reply.toDate) {
    script += `if currentdate :value "le" "iso8601" "${reply.toDate}" {\r\n`;
    blocks++;
  }
  script += 'vacation :mime ';
  if (reply.subject !== undefined) script += `:subject "${escape(reply.subject.replace(/[\r\n]/g, ''))}" `;
  script += `"${escape(reply.mimeBody)}";\r\n`;
  return script + '}\r\n'.repeat(blocks);
}

/** Stalwart 1.2's "managed" script with the auto-reply off and no rule of its own. */
export const STALWART_MANAGED_IDLE = '# Managed by the server\n';

interface VacationFields {
  fromDate: string | null;
  toDate: string | null;
  subject: string;
  textBody: string;
  htmlBody: string | null;
}

/**
 * A Sieve account that behaves like Stalwart for VacationResponse: turning
 * the auto-reply on activates its own "vacation" script, which switches
 * every other script off, and it reads as on only while that script is the
 * active one. Like Stalwart, an update that leaves isEnabled out switches
 * that script off, and one redirect per message is the default limit.
 *
 * With `managedScript` it behaves like Stalwart 1.2 instead: the auto-reply
 * lives in the read-only "managed" script, which no client write may touch.
 * It runs while "managed" is the active script or the active script includes
 * it (without :global). Turning the auto-reply on activates "managed" only
 * when it does not run yet; turning it off switches "managed" off only when
 * it is the active script. The auto-reply reads as on only while it runs, and
 * an update that leaves isEnabled out keeps the switch while it runs.
 *
 * With `managedRules` the user also has mail rules or sender lists set in
 * Stalwart itself, which "managed" runs: it then has something to run without
 * the auto-reply, so the server activates it and never switches it off.
 */
export function mockStalwartAccount(
  accountId: string,
  initial: Parameters<typeof mockSieveAccount>[1],
  extensions: string[],
  options: {
    maxNumberRedirects?: number; vacation?: Partial<VacationFields>; managedScript?: boolean; managedRules?: boolean;
  } = {},
) {
  const managedScript = options.managedScript === true;
  const managedRules = options.managedRules === true;
  const isManaged = (name: string) => name.toLowerCase() === 'managed';
  const account = mockSieveAccount(accountId, initial, extensions, managedScript ? { readOnly: isManaged } : {});
  let managedEnabled = false;
  /** How Stalwart 1.2 runs "managed": as the active script, through an include, or not at all. */
  const managedRuns = (): 'active' | 'included' | 'inactive' => {
    const active = account.scripts.find((s) => s.isActive);
    if (!active) return 'inactive';
    if (isManaged(active.name)) return 'active';
    return /\binclude\b(?![^;]*:global)[^;]*"managed"\s*;/i.test(account.content(active.name)) ? 'included' : 'inactive';
  };
  let vacation: VacationFields = { fromDate: null, toDate: null, subject: '', textBody: 'away', htmlBody: null, ...options.vacation };
  const maxNumberRedirects = 'maxNumberRedirects' in options ? options.maxNumberRedirects : 1;
  const client = Object.assign(account.client, {
    supportsSieve: () => true,
    accountSupports: () => true,
    hasAccountCapability: () => false,
    getSieveAccounts: () => [{ id: accountId, name: 'Me', isPrimary: true }],
    getSieveCapabilities: () => ({ sieveExtensions: extensions, maxNumberRedirects }) as never,
    getVacationResponse: vi.fn(async () => ({
      ...vacation,
      isEnabled: managedScript ? managedEnabled && managedRuns() !== 'inactive' : account.active() === 'vacation',
    })),
    setVacationResponse: vi.fn(async (updates: Record<string, unknown>) => {
      const { isEnabled, ...fields } = updates;
      vacation = { ...vacation, ...fields };
      if (managedScript) {
        const runs = managedRuns();
        if (isEnabled !== undefined) managedEnabled = isEnabled === true;
        else if (runs === 'inactive') managedEnabled = false;
        const runsAnything = managedEnabled || managedRules;
        const script = account.put('managed', managedEnabled ? STALWART_VACATION_SCRIPT : STALWART_MANAGED_IDLE);
        if (runsAnything && runs === 'inactive') await client.activateSieveScript(script.id, accountId);
        else if (!runsAnything && runs === 'active') await client.deactivateSieveScript(accountId);
        return;
      }
      if (isEnabled === true) {
        const own = account.scripts.find((s) => s.name === 'vacation');
        if (own) await client.activateSieveScript(own.id, accountId);
        // The server writes its own script, never through the client.
        else await client.activateSieveScript(account.put('vacation', STALWART_VACATION_SCRIPT).id, accountId);
      } else if (account.active() === 'vacation') {
        await client.deactivateSieveScript(accountId);
      }
    }),
  });
  return { ...account, client };
}
