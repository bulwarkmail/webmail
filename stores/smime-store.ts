import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SmimeKeyRecord, SmimePublicCert } from '@/lib/smime/types';
import { generateUUID } from '@/lib/utils';
import {
  saveKeyRecord,
  listKeyRecords,
  deleteKeyRecord as deleteKeyRecordDB,
  savePublicCert,
  listPublicCerts,
  deletePublicCert as deletePublicCertDB,
} from '@/lib/smime/key-storage';
import { importPkcs12, unlockPrivateKey } from '@/lib/smime/pkcs12-import';
import {
  parseCertificatePemOrDer,
  extractCertificateInfo,
} from '@/lib/smime/certificate-utils';

const REMEMBERED_UNLOCKS_STORAGE_KEY = 'smime-unlocked-session';

type RememberedUnlocks = Record<string, string>;

function readRememberedUnlocks(): RememberedUnlocks {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.sessionStorage.getItem(REMEMBERED_UNLOCKS_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const rememberedUnlocks: RememberedUnlocks = {};
    for (const [keyId, passphrase] of Object.entries(parsed)) {
      if (typeof passphrase === 'string') {
        rememberedUnlocks[keyId] = passphrase;
      }
    }

    return rememberedUnlocks;
  } catch {
    return {};
  }
}

function writeRememberedUnlocks(rememberedUnlocks: RememberedUnlocks): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (Object.keys(rememberedUnlocks).length === 0) {
      window.sessionStorage.removeItem(REMEMBERED_UNLOCKS_STORAGE_KEY);
      return;
    }

    window.sessionStorage.setItem(
      REMEMBERED_UNLOCKS_STORAGE_KEY,
      JSON.stringify(rememberedUnlocks),
    );
  } catch {
    // Ignore unavailable or blocked session storage.
  }
}

function rememberUnlockedKey(keyId: string, passphrase: string): void {
  const rememberedUnlocks = readRememberedUnlocks();
  rememberedUnlocks[keyId] = passphrase;
  writeRememberedUnlocks(rememberedUnlocks);
}

function forgetUnlockedKey(keyId: string): void {
  const rememberedUnlocks = readRememberedUnlocks();
  if (!(keyId in rememberedUnlocks)) {
    return;
  }

  delete rememberedUnlocks[keyId];
  writeRememberedUnlocks(rememberedUnlocks);
}

function clearRememberedUnlocks(): void {
  writeRememberedUnlocks({});
}

async function restoreRememberedKeys(keyRecords: SmimeKeyRecord[]): Promise<{
  unlockedKeys: Map<string, CryptoKey>;
  unlockedDecryptionKeys: Map<string, CryptoKey>;
  unlockedLegacyDecryptionKeys: Map<string, CryptoKey>;
}> {
  const rememberedUnlocks = readRememberedUnlocks();
  const unlockedKeys = new Map<string, CryptoKey>();
  const unlockedDecryptionKeys = new Map<string, CryptoKey>();
  const unlockedLegacyDecryptionKeys = new Map<string, CryptoKey>();
  let removedStaleEntries = false;

  for (const record of keyRecords) {
    const passphrase = rememberedUnlocks[record.id];
    if (!passphrase) {
      continue;
    }

    try {
      const { signingKey, decryptionKey, legacyDecryptionKey } = await unlockPrivateKey(record, passphrase);
      unlockedKeys.set(record.id, signingKey);
      if (decryptionKey) {
        unlockedDecryptionKeys.set(record.id, decryptionKey);
      }
      if (legacyDecryptionKey) {
        unlockedLegacyDecryptionKeys.set(record.id, legacyDecryptionKey);
      }
    } catch {
      delete rememberedUnlocks[record.id];
      removedStaleEntries = true;
    }
  }

  if (removedStaleEntries) {
    writeRememberedUnlocks(rememberedUnlocks);
  }

  return { unlockedKeys, unlockedDecryptionKeys, unlockedLegacyDecryptionKeys };
}

interface SmimePersistedState {
  /** Account-scoped preferences: accountId → { identityKeyBindings, defaultSignIdentity, defaultEncrypt } */
  accountPreferences: Record<string, {
    identityKeyBindings: Record<string, string>;
    defaultSignIdentity: Record<string, boolean>;
    defaultEncrypt: boolean;
  }>;
  rememberUnlockedKeys: boolean;
  autoImportSignerCerts: boolean;
}

interface SmimeStore extends SmimePersistedState {
  // Current account scope
  currentAccountId: string | null;
  // Account-scoped convenience accessors (derived from accountPreferences + currentAccountId)
  identityKeyBindings: Record<string, string>;
  defaultSignIdentity: Record<string, boolean>;
  defaultEncrypt: boolean;
  // Loaded from IndexedDB
  keyRecords: SmimeKeyRecord[];
  publicCerts: SmimePublicCert[];
  // Runtime only - never persisted
  unlockedKeys: Map<string, CryptoKey>;
  unlockedDecryptionKeys: Map<string, CryptoKey>;
  unlockedLegacyDecryptionKeys: Map<string, CryptoKey>;
  isLoading: boolean;
  error: string | null;

  // Actions
  load: (accountId?: string) => Promise<void>;
  clearState: () => void;
  importPKCS12: (file: ArrayBuffer, p12Passphrase: string, storagePassphrase: string) => Promise<SmimeKeyRecord>;
  importPublicCert: (data: ArrayBuffer | string, source: SmimePublicCert['source'], contactId?: string) => Promise<SmimePublicCert>;
  bindIdentityToKey: (identityId: string, keyRecordId: string | null) => void;
  removeKeyRecord: (id: string) => Promise<void>;
  removePublicCert: (id: string) => Promise<void>;
  unlockKey: (id: string, passphrase: string) => Promise<void>;
  lockKey: (id: string) => void;
  lockAllKeys: () => void;
  getKeyRecordForIdentity: (identityId: string) => SmimeKeyRecord | undefined;
  getPublicCertForEmail: (email: string) => SmimePublicCert | undefined;
  getRecipientCerts: (emails: string[]) => { found: SmimePublicCert[]; missing: string[] };
  setSignDefault: (identityId: string, value: boolean) => void;
  setEncryptDefault: (value: boolean) => void;
  setRememberUnlockedKeys: (value: boolean) => void;
  setAutoImportSignerCerts: (value: boolean) => void;
  isKeyUnlocked: (id: string) => boolean;
  getUnlockedKey: (id: string) => CryptoKey | undefined;
  setError: (error: string | null) => void;
}

export const useSmimeStore = create<SmimeStore>()(
  persist(
    (set, get) => ({
      // Persisted preferences
      accountPreferences: {},
      rememberUnlockedKeys: false,
      autoImportSignerCerts: true,

      // Runtime state
      currentAccountId: null,
      identityKeyBindings: {},
      defaultSignIdentity: {},
      defaultEncrypt: false,
      keyRecords: [],
      publicCerts: [],
      unlockedKeys: new Map(),
      unlockedDecryptionKeys: new Map(),
      unlockedLegacyDecryptionKeys: new Map(),
      isLoading: false,
      error: null,

      load: async (accountId) => {
        const acctId = accountId ?? get().currentAccountId;
        set({ isLoading: true, error: null, currentAccountId: acctId });

        // Restore account-scoped preferences
        const prefs = acctId ? get().accountPreferences[acctId] : undefined;
        if (prefs) {
          set({
            identityKeyBindings: prefs.identityKeyBindings,
            defaultSignIdentity: prefs.defaultSignIdentity,
            defaultEncrypt: prefs.defaultEncrypt,
          });
        } else {
          set({
            identityKeyBindings: {},
            defaultSignIdentity: {},
            defaultEncrypt: false,
          });
        }

        try {
          const [keyRecords, publicCerts] = await Promise.all([
            listKeyRecords(acctId ?? undefined),
            listPublicCerts(acctId ?? undefined),
          ]);

          if (get().rememberUnlockedKeys) {
            const restoredKeys = await restoreRememberedKeys(keyRecords);
            set((state) => ({
              keyRecords,
              publicCerts,
              unlockedKeys: new Map([
                ...state.unlockedKeys,
                ...restoredKeys.unlockedKeys,
              ]),
              unlockedDecryptionKeys: new Map([
                ...state.unlockedDecryptionKeys,
                ...restoredKeys.unlockedDecryptionKeys,
              ]),
              unlockedLegacyDecryptionKeys: new Map([
                ...state.unlockedLegacyDecryptionKeys,
                ...restoredKeys.unlockedLegacyDecryptionKeys,
              ]),
              isLoading: false,
            }));
            return;
          }

          set({ keyRecords, publicCerts, isLoading: false });
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : 'Failed to load S/MIME data',
            isLoading: false,
          });
        }
      },

      importPKCS12: async (file, p12Passphrase, storagePassphrase) => {
        set({ isLoading: true, error: null });
        try {
          const { keyRecord } = await importPkcs12(file, p12Passphrase, storagePassphrase);
          const acctId = get().currentAccountId;
          if (acctId) keyRecord.accountId = acctId;
          await saveKeyRecord(keyRecord);
          set((state) => ({
            keyRecords: [...state.keyRecords, keyRecord],
            isLoading: false,
          }));
          return keyRecord;
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : 'Failed to import PKCS#12',
            isLoading: false,
          });
          throw err;
        }
      },

      importPublicCert: async (data, source, contactId) => {
        set({ isLoading: true, error: null });
        try {
          const cert = parseCertificatePemOrDer(data);
          // Always re-encode to DER - input might be PEM text (string or ArrayBuffer)
          const der = cert.toSchema(true).toBER(false);
          const info = await extractCertificateInfo(cert, der);
          const email = info.emailAddresses[0] ?? '';

          const publicCert: SmimePublicCert = {
            id: generateUUID(),
            accountId: get().currentAccountId ?? undefined,
            email: email.toLowerCase(),
            certificate: der,
            issuer: info.issuer,
            subject: info.subject,
            notBefore: info.notBefore,
            notAfter: info.notAfter,
            fingerprint: info.fingerprint,
            source,
            contactId,
          };

          await savePublicCert(publicCert);
          set((state) => ({
            publicCerts: [...state.publicCerts, publicCert],
            isLoading: false,
          }));
          return publicCert;
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : 'Failed to import certificate',
            isLoading: false,
          });
          throw err;
        }
      },

      bindIdentityToKey: (identityId, keyRecordId) => {
        set((state) => {
          const bindings = { ...state.identityKeyBindings };
          if (keyRecordId === null) {
            delete bindings[identityId];
          } else {
            bindings[identityId] = keyRecordId;
          }
          const accountPreferences = { ...state.accountPreferences };
          const acctId = state.currentAccountId;
          if (acctId) {
            accountPreferences[acctId] = {
              ...(accountPreferences[acctId] ?? { identityKeyBindings: {}, defaultSignIdentity: {}, defaultEncrypt: false }),
              identityKeyBindings: bindings,
            };
          }
          return { identityKeyBindings: bindings, accountPreferences };
        });
      },

      removeKeyRecord: async (id) => {
        await deleteKeyRecordDB(id);
        forgetUnlockedKey(id);
        set((state) => {
          const unlockedKeys = new Map(state.unlockedKeys);
          unlockedKeys.delete(id);
          const unlockedDecryptionKeys = new Map(state.unlockedDecryptionKeys);
          unlockedDecryptionKeys.delete(id);
          const unlockedLegacyDecryptionKeys = new Map(state.unlockedLegacyDecryptionKeys);
          unlockedLegacyDecryptionKeys.delete(id);
          // Remove any identity bindings pointing to this key
          const bindings = { ...state.identityKeyBindings };
          for (const [identityId, keyId] of Object.entries(bindings)) {
            if (keyId === id) delete bindings[identityId];
          }
          const accountPreferences = { ...state.accountPreferences };
          const acctId = state.currentAccountId;
          if (acctId && accountPreferences[acctId]) {
            accountPreferences[acctId] = { ...accountPreferences[acctId], identityKeyBindings: bindings };
          }
          return {
            keyRecords: state.keyRecords.filter((k) => k.id !== id),
            unlockedKeys,
            unlockedDecryptionKeys,
            unlockedLegacyDecryptionKeys,
            identityKeyBindings: bindings,
            accountPreferences,
          };
        });
      },

      removePublicCert: async (id) => {
        await deletePublicCertDB(id);
        set((state) => ({
          publicCerts: state.publicCerts.filter((c) => c.id !== id),
        }));
      },

      unlockKey: async (id, passphrase) => {
        const record = get().keyRecords.find((k) => k.id === id);
        if (!record) throw new Error('Key record not found');

        const { signingKey, decryptionKey, legacyDecryptionKey } = await unlockPrivateKey(record, passphrase);
        if (get().rememberUnlockedKeys) {
          rememberUnlockedKey(id, passphrase);
        }
        set((state) => {
          const unlockedKeys = new Map(state.unlockedKeys);
          unlockedKeys.set(id, signingKey);
          const unlockedDecryptionKeys = new Map(state.unlockedDecryptionKeys);
          if (decryptionKey) {
            unlockedDecryptionKeys.set(id, decryptionKey);
          }
          const unlockedLegacyDecryptionKeys = new Map(state.unlockedLegacyDecryptionKeys);
          if (legacyDecryptionKey) {
            unlockedLegacyDecryptionKeys.set(id, legacyDecryptionKey);
          }
          return { unlockedKeys, unlockedDecryptionKeys, unlockedLegacyDecryptionKeys };
        });
      },

      lockKey: (id) => {
        forgetUnlockedKey(id);
        set((state) => {
          const unlockedKeys = new Map(state.unlockedKeys);
          unlockedKeys.delete(id);
          const unlockedDecryptionKeys = new Map(state.unlockedDecryptionKeys);
          unlockedDecryptionKeys.delete(id);
          const unlockedLegacyDecryptionKeys = new Map(state.unlockedLegacyDecryptionKeys);
          unlockedLegacyDecryptionKeys.delete(id);
          return { unlockedKeys, unlockedDecryptionKeys, unlockedLegacyDecryptionKeys };
        });
      },

      lockAllKeys: () => {
        clearRememberedUnlocks();
        set({ unlockedKeys: new Map(), unlockedDecryptionKeys: new Map(), unlockedLegacyDecryptionKeys: new Map() });
      },

      getKeyRecordForIdentity: (identityId) => {
        const { identityKeyBindings, keyRecords } = get();
        const keyId = identityKeyBindings[identityId];
        if (!keyId) return undefined;
        return keyRecords.find((k) => k.id === keyId);
      },

      getPublicCertForEmail: (email) => {
        return get().publicCerts.find(
          (c) => c.email.toLowerCase() === email.toLowerCase(),
        );
      },

      getRecipientCerts: (emails) => {
        const { publicCerts } = get();
        const found: SmimePublicCert[] = [];
        const missing: string[] = [];
        for (const email of emails) {
          const cert = publicCerts.find(
            (c) => c.email.toLowerCase() === email.toLowerCase(),
          );
          if (cert) {
            found.push(cert);
          } else {
            missing.push(email);
          }
        }
        return { found, missing };
      },

      setSignDefault: (identityId, value) => {
        set((state) => {
          const defaultSignIdentity = { ...state.defaultSignIdentity, [identityId]: value };
          const accountPreferences = { ...state.accountPreferences };
          const acctId = state.currentAccountId;
          if (acctId) {
            accountPreferences[acctId] = {
              ...(accountPreferences[acctId] ?? { identityKeyBindings: {}, defaultSignIdentity: {}, defaultEncrypt: false }),
              defaultSignIdentity,
            };
          }
          return { defaultSignIdentity, accountPreferences };
        });
      },

      setEncryptDefault: (value) => {
        set((state) => {
          const accountPreferences = { ...state.accountPreferences };
          const acctId = state.currentAccountId;
          if (acctId) {
            accountPreferences[acctId] = {
              ...(accountPreferences[acctId] ?? { identityKeyBindings: {}, defaultSignIdentity: {}, defaultEncrypt: false }),
              defaultEncrypt: value,
            };
          }
          return { defaultEncrypt: value, accountPreferences };
        });
      },

      setRememberUnlockedKeys: (value) => {
        set({ rememberUnlockedKeys: value });
        if (!value) {
          clearRememberedUnlocks();
          set({ unlockedKeys: new Map(), unlockedDecryptionKeys: new Map() });
        }
      },

      setAutoImportSignerCerts: (value) => {
        set({ autoImportSignerCerts: value });
      },

      isKeyUnlocked: (id) => get().unlockedKeys.has(id),

      getUnlockedKey: (id) => get().unlockedKeys.get(id),

      clearState: () => {
        clearRememberedUnlocks();
        set({
          keyRecords: [],
          publicCerts: [],
          unlockedKeys: new Map(),
          unlockedDecryptionKeys: new Map(),
          unlockedLegacyDecryptionKeys: new Map(),
          identityKeyBindings: {},
          defaultSignIdentity: {},
          defaultEncrypt: false,
          currentAccountId: null,
          isLoading: false,
          error: null,
        });
      },

      setError: (error) => set({ error }),
    }),
    {
      name: 'smime-preferences',
      partialize: (state): SmimePersistedState => ({
        accountPreferences: state.accountPreferences,
        rememberUnlockedKeys: state.rememberUnlockedKeys,
        autoImportSignerCerts: state.autoImportSignerCerts,
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<SmimePersistedState & { identityKeyBindings?: Record<string, string>; defaultSignIdentity?: Record<string, boolean>; defaultEncrypt?: boolean }>;
        return {
          ...current,
          // Migrate legacy flat preferences into accountPreferences
          accountPreferences: p?.accountPreferences ?? {},
          rememberUnlockedKeys: p?.rememberUnlockedKeys ?? false,
          autoImportSignerCerts: p?.autoImportSignerCerts ?? true,
        };
      },
    },
  ),
);
