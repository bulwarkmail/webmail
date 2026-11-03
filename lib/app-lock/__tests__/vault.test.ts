import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccountRecord, openAccountKey, rewrapAccountKey, StoreKeyLayerMissingError } from '@/lib/store/client/keys';
import { importLockKey, lockLayer, mainProof, PBKDF2_ITERATIONS, pinIsObvious, pinLongEnough } from '../crypto';
import { changeVaultPin, createVault, deleteVault, FREE_FAILURES, LONGEST_WAIT_MS, openSealedDrafts, openVaultWithPin, PinBlockedError, pinBlockedUntil, readVault, sealDraft, waitAfter, WrongPinError } from '../vault';

const PIN = 'correct-pin';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

beforeEach(async () => {
  await deleteVault();
});

describe('the PIN', () => {
  it('uses PBKDF2 with at least 600,000 iterations and a random salt', async () => {
    (await createVault(PIN)).fill(0);
    const first = await readVault();
    expect(first?.pin.iterations).toBeGreaterThanOrEqual(600_000);
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    await deleteVault();
    (await createVault(PIN)).fill(0);
    const second = await readVault();
    expect(hex(second!.pin.salt)).not.toBe(hex(first!.pin.salt));
  });

  it('opens the lock key with the right PIN and not with a wrong one', async () => {
    const raw = await createVault(PIN);
    expect(hex(await openVaultWithPin(PIN))).toBe(hex(raw));
    await expect(openVaultWithPin('wrong-pin')).rejects.toBeInstanceOf(WrongPinError);
  });

  it('keeps nothing readable: the lock key isn\'t in what is stored', async () => {
    const raw = await createVault(PIN);
    const stored = await readVault();
    const bytes = hex(stored!.pin.data);
    expect(bytes).not.toContain(hex(raw));
    expect(JSON.stringify(stored)).not.toContain(PIN);
  });

  it.each([
    '000000', '999999', 'aaaaaa', '123456', '654321', '234567', '012345', '1234567890', 'abcdef', 'ABCDEF', 'fedcba',
    '121212', '123123', 'abcabc', '112233', 'password', 'Password1', 'qwerty', 'qwertz', '147258', '159753', '1q2w3e', 'letmein',
  ])('refuses %s as too easy to guess', (pin) => {
    expect(pinIsObvious(pin)).toBe(true);
  });

  it.each(['it-pin-4827', 'correct-pin', '482913', '135792', 'horse battery', '1234567a9'])('takes %s', (pin) => {
    expect(pinIsObvious(pin)).toBe(false);
  });

  it('must be long enough, counted in characters', () => {
    expect(pinLongEnough('12345')).toBe(false);
    expect(pinLongEnough('123456')).toBe(true);
  });
});

describe('in the desktop app, with main\'s safeStorage', () => {
  function shell(overrides: Record<string, unknown> = {}) {
    const appLock = {
      status: vi.fn(async () => ({ locked: false, enrolled: false, os: null, osEnrolled: false, wrap: true })),
      wrap: vi.fn(async (data: Uint8Array) => Uint8Array.from([9, ...data])),
      unwrap: vi.fn(async (data: Uint8Array) => (data[0] === 9 ? data.slice(1) : null)),
      ...overrides,
    };
    (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', appLock };
    return appLock;
  }

  afterEach(() => {
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  });

  it('goes through main, and opens only through main', async () => {
    const appLock = shell();
    const raw = await createVault(PIN);
    expect(appLock.wrap).toHaveBeenCalledTimes(1);
    expect((await readVault())!.pin.shell).toBe(true);
    expect(hex(await openVaultWithPin(PIN))).toBe(hex(raw));
    expect(appLock.unwrap).toHaveBeenCalledTimes(1);
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    await expect(openVaultWithPin(PIN)).rejects.toMatchObject({ name: 'VaultShellError' });
  });

  it('main saying no isn\'t a wrong PIN, and costs no try', async () => {
    shell();
    await createVault(PIN);
    shell({ unwrap: vi.fn(async () => null) });
    for (let i = 0; i < FREE_FAILURES + 2; i += 1) {
      await expect(openVaultWithPin(PIN)).rejects.toMatchObject({ name: 'VaultShellError' });
    }
    shell();
    await expect(openVaultWithPin(PIN)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('a changed PIN goes through main too', async () => {
    const appLock = shell();
    await createVault(PIN);
    await changeVaultPin(PIN, 'next-pin-5521');
    expect(appLock.wrap).toHaveBeenCalledTimes(2);
    expect((await readVault())!.pin.shell).toBe(true);
    await expect(openVaultWithPin('next-pin-5521')).resolves.toBeInstanceOf(Uint8Array);
  });

  it('a shell whose storage only obfuscates: no wrap, and it says so in the record', async () => {
    const appLock = shell({ status: vi.fn(async () => ({ locked: false, enrolled: false, os: null, osEnrolled: false, wrap: false })) });
    await createVault(PIN);
    expect(appLock.wrap).not.toHaveBeenCalled();
    expect((await readVault())!.pin.shell).toBeUndefined();
  });

  it('with no shell at all, a browser: nothing changes', async () => {
    await createVault(PIN);
    expect((await readVault())!.pin.shell).toBeUndefined();
  });
});

describe('wrong PINs', () => {
  const NOW = 1_700_000_000_000;

  async function failTimes(count: number, now = NOW): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await openVaultWithPin('wrong-pin', now + i).catch((error) => {
        if ((error as Error).name !== 'WrongPinError') throw error;
      });
    }
  }

  it('cost nothing at first, then a growing wait, up to a long one and no wipe', () => {
    expect(waitAfter(FREE_FAILURES)).toBe(0);
    expect(waitAfter(FREE_FAILURES + 1)).toBe(30_000);
    expect(waitAfter(FREE_FAILURES + 2)).toBe(60_000);
    expect(waitAfter(1000)).toBe(LONGEST_WAIT_MS);
  });

  it('block the next try even with the right PIN', async () => {
    await createVault(PIN);
    await failTimes(FREE_FAILURES + 1);
    await expect(openVaultWithPin(PIN, NOW + FREE_FAILURES + 2)).rejects.toBeInstanceOf(PinBlockedError);
  });

  it('are still counted after a reload', async () => {
    await createVault(PIN);
    await failTimes(FREE_FAILURES + 1);
    vi.resetModules();
    const fresh = await import('../vault');
    await expect(fresh.openVaultWithPin(PIN, NOW + 100)).rejects.toMatchObject({ name: 'PinBlockedError' });
    expect(await fresh.pinBlockedUntil(NOW + 100)).toBeGreaterThan(NOW + 100);
  });

  it('are counted before the check, so leaving during one gains nothing', async () => {
    await createVault(PIN);
    await failTimes(FREE_FAILURES);
    // A check that never finishes: the page was closed while PBKDF2 ran.
    const derive = vi.spyOn(crypto.subtle, 'deriveKey').mockImplementationOnce(() => new Promise(() => {}));
    void openVaultWithPin('wrong-pin', NOW + 50);
    await vi.waitFor(() => expect(derive).toHaveBeenCalled());
    derive.mockRestore();
    expect(await pinBlockedUntil(NOW + 51)).toBeGreaterThan(NOW + 51);
  });

  it('are forgotten after the right PIN', async () => {
    await createVault(PIN);
    await failTimes(FREE_FAILURES);
    await openVaultWithPin(PIN, NOW + 100);
    expect(await pinBlockedUntil(NOW + 200)).toBe(0);
    await failTimes(FREE_FAILURES, NOW + 200);
    expect(await pinBlockedUntil(NOW + 300)).toBe(0);
  });

  it('count again after the wait, for longer', async () => {
    await createVault(PIN);
    await failTimes(FREE_FAILURES + 1);
    const later = NOW + 31_000;
    await expect(openVaultWithPin('wrong-pin', later)).rejects.toBeInstanceOf(WrongPinError);
    expect(await pinBlockedUntil(later)).toBe(later + 60_000);
  });
});

describe('the account keys under the lock', () => {
  it('can\'t be read from disk without the lock key, and read back the same with it', async () => {
    const { keyHex } = await openAccountKey('acc-layer');
    const raw = await createVault(PIN);
    const layer = lockLayer(await importLockKey(raw));
    await rewrapAccountKey('acc-layer', [layer], [layer]);

    const record = await getAccountRecord('acc-layer');
    expect(record?.layers).toEqual(['applock']);
    expect(hex(record!.wrapped)).not.toContain(keyHex);
    await expect(openAccountKey('acc-layer')).rejects.toBeInstanceOf(StoreKeyLayerMissingError);

    const other = lockLayer(await importLockKey(new Uint8Array(32).fill(9)));
    await expect(openAccountKey('acc-layer', [other])).rejects.toBeDefined();

    expect((await openAccountKey('acc-layer', [layer])).keyHex).toBe(keyHex);
  });

  it('come off the layer again without changing the database key', async () => {
    const { keyHex } = await openAccountKey('acc-off');
    const raw = await createVault(PIN);
    const layer = lockLayer(await importLockKey(raw));
    await rewrapAccountKey('acc-off', [layer], [layer]);
    await rewrapAccountKey('acc-off', [layer], []);
    expect((await getAccountRecord('acc-off'))?.layers).toEqual([]);
    expect((await openAccountKey('acc-off')).keyHex).toBe(keyHex);
  });
});

describe('a draft a locking window couldn\'t save', () => {
  it('can be sealed with no key, and only the lock key opens it', async () => {
    const raw = await createVault(PIN);
    const key = await importLockKey(raw);
    await sealDraft({ subject: 'Secret plan' });
    await expect(openSealedDrafts(await importLockKey(new Uint8Array(32).fill(1)))).rejects.toBeDefined();
    expect(await openSealedDrafts(key)).toEqual([{ subject: 'Secret plan' }]);
    expect(await openSealedDrafts(key)).toEqual([]);
  });
});

describe('the proof for the desktop app', () => {
  it('follows from the lock key and isn\'t the lock key', async () => {
    const raw = new Uint8Array(32).fill(3);
    const proof = await mainProof(raw);
    expect(hex(proof)).not.toBe(hex(raw));
    expect(hex(await mainProof(raw))).toBe(hex(proof));
    expect(hex(await mainProof(new Uint8Array(32).fill(4)))).not.toBe(hex(proof));
  });
});
