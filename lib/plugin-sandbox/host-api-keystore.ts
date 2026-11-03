// Host side of api.keystore: the OS certificate store and smart cards, for an
// S/MIME plugin, in the desktop app. Signing and decrypting happen in the OS. The
// private key never reaches the webmail, and the OS's own prompts stay on.
//
// Privileged tier only (host-api.ts), so a user-uploaded plugin never gets here.
// A privileged frame is same-origin and can reach window.parent.bulwarkDesktop
// directly; these checks are for the front door, and the safeguards that hold in
// both cases are in the shell and the OS.
//
// RPC errors reach the frame as message strings only, so the code is the message:
// keystore:cancelled, keystore:not-found, keystore:unsupported, keystore:locked,
// keystore:invalid, keystore:failed.

import type { InstalledPlugin } from '../plugin-types';
import type { DesktopKeystoreBridge, DesktopKeystoreCertificate } from '../desktop/types';
import { holdForUser } from './host-dialog';
import { pluginHasPermission } from './permissions';
import { resolvePluginTier } from './tier';

const MAX_ID = 64;
const MAX_DIGEST = 64;
// A 16384-bit modulus, the most anything issues.
const MAX_CIPHERTEXT = 2048;
const MAX_LABEL = 256;
const MAX_PEER_KEY = 256;

const HASHES = new Set(['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']);
const SIGN_SCHEMES = new Set(['rsa-pkcs1', 'rsa-pss', 'ecdsa']);
const DECRYPT_SCHEMES = new Set(['rsa-pkcs1', 'rsa-oaep']);

export const KEYSTORE_PERMS = {
  'keystore.list': 'keystore',
  'keystore.sign': 'keystore',
  'keystore.decrypt': 'keystore',
  'keystore.agree': 'keystore',
} as const;

export const KEYSTORE_METHODS: readonly string[] = Object.keys(KEYSTORE_PERMS);

function desktopKeystore(): DesktopKeystoreBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.bulwarkDesktop?.keystore;
}

/** api.host.features.keystore for this plugin. Absent rather than false when it's not: older hosts don't name it. */
export function keystoreFeature(plugin?: InstalledPlugin): { keystore?: true } {
  if (!plugin || !desktopKeystore()) return {};
  if (resolvePluginTier(plugin).tier !== 'privileged' || !pluginHasPermission(plugin, 'keystore')) return {};
  return { keystore: true };
}

function invalid(): Error {
  return new Error('keystore:invalid');
}

function readId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_ID) throw invalid();
  return value;
}

function readBytes(value: unknown, max: number): Uint8Array {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > max) throw invalid();
  return bytes;
}

function readScheme(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function readHash(value: unknown): string {
  if (typeof value !== 'string' || !HASHES.has(value)) throw invalid();
  return value;
}

function checkedSignScheme(value: unknown): { scheme: string; hash: string } {
  const scheme = readScheme(value);
  if (typeof scheme.scheme !== 'string' || !SIGN_SCHEMES.has(scheme.scheme)) throw invalid();
  return { scheme: scheme.scheme, hash: readHash(scheme.hash) };
}

function checkedDecryptScheme(value: unknown): { scheme: string; hash?: string; label?: Uint8Array } {
  const scheme = readScheme(value);
  if (typeof scheme.scheme !== 'string' || !DECRYPT_SCHEMES.has(scheme.scheme)) throw invalid();
  if (scheme.scheme === 'rsa-pkcs1') return { scheme: scheme.scheme };
  const label = scheme.label === undefined || (scheme.label instanceof Uint8Array && scheme.label.byteLength === 0)
    ? undefined
    : readBytes(scheme.label, MAX_LABEL);
  return { scheme: scheme.scheme, hash: readHash(scheme.hash), ...(label ? { label } : {}) };
}

/** Only the code, whatever the bridge put around it. */
function codeOnly(error: unknown): Error {
  const code = /keystore:[a-z-]+/.exec(error instanceof Error ? error.message : String(error))?.[0];
  return new Error(code ?? 'keystore:failed');
}

export async function doKeystoreCall(plugin: InstalledPlugin, method: string, args: unknown[]): Promise<unknown> {
  const keystore = desktopKeystore();
  // A browser, a build without the helper, a plugin on an older shell.
  if (!keystore) throw new Error('keystore:unsupported');

  const run = (): Promise<DesktopKeystoreCertificate[] | Uint8Array> => {
    switch (method) {
      case 'keystore.list':
        return keystore.list();
      case 'keystore.sign':
        return keystore.sign(readId(args[0]), readBytes(args[1], MAX_DIGEST), checkedSignScheme(args[2]) as never);
      case 'keystore.decrypt':
        return keystore.decrypt(readId(args[0]), readBytes(args[1], MAX_CIPHERTEXT), checkedDecryptScheme(args[2]) as never);
      case 'keystore.agree':
        return keystore.agree(readId(args[0]), readBytes(args[1], MAX_PEER_KEY));
      default:
        throw new Error('keystore:unsupported');
    }
  };

  // The OS may be showing a PIN dialog right now, which the host can't see. While it
  // is, the plugin is waiting on the user, not hung: this holds the hook timer the
  // way one of its own dialogs does, so a card's PIN during onRenderEmailBody doesn't
  // count towards auto-disable.
  const release = holdForUser(plugin.id);
  try {
    return await run();
  } catch (error) {
    throw codeOnly(error);
  } finally {
    release();
  }
}
