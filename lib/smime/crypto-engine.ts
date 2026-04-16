/**
 * Crypto engine backed by webcrypto-liner for legacy algorithm support.
 *
 * webcrypto-liner extends the native Web Crypto API with algorithms
 * like DES-EDE3-CBC (3DES) that are commonly found in S/MIME messages
 * and PKCS#12 files produced by legacy clients (Outlook, Thunderbird, etc.).
 *
 * Native Web Crypto calls are passed through to the real implementation;
 * liner only intercepts algorithms that the browser doesn't natively support.
 *
 * Additionally, pkijs's CryptoEngine.decryptEncryptedContentInfo only
 * handles PBES2 (OID 1.2.840.113549.1.5.13). Many PKCS#12 files use
 * legacy PBE algorithms (e.g. pbeWithSHAAnd3-KeyTripleDES-CBC). We
 * extend CryptoEngine to handle those via RFC 7292 Appendix B key
 * derivation + webcrypto-liner's DES-EDE3-CBC support.
 */

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

// webcrypto-liner exports a Crypto constructor at runtime that extends native
// Web Crypto with legacy algorithms (3DES, etc.). Its type declarations only
// expose the type alias, so we import the module dynamically and cast.
// Import the ES module build directly - the package's "browser" field points
// to a shim-only build that has no named exports (no setCrypto, Crypto, etc.).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const liner = require('webcrypto-liner/build/index.es.js') as {
  Crypto: { new (): Crypto };
  setCrypto: (subtle: SubtleCrypto) => void;
  nativeCrypto: Crypto | Record<string, never>;
};

// ── PKCS#12 legacy PBE OIDs ──────────────────────────────────────────
const PBE_SHA1_3DES_3KEY = '1.2.840.113549.1.12.1.3'; // pbeWithSHAAnd3-KeyTripleDES-CBC
const PBE_SHA1_3DES_2KEY = '1.2.840.113549.1.12.1.4'; // pbeWithSHAAnd2-KeyTripleDES-CBC
const PBE_SHA1_RC2_128 = '1.2.840.113549.1.12.1.5';   // pbeWithSHAAnd128BitRC2-CBC
const PBE_SHA1_RC2_40 = '1.2.840.113549.1.12.1.6';    // pbeWithSHAAnd40BitRC2-CBC

const LEGACY_PBE_OIDS = new Set([
  PBE_SHA1_3DES_3KEY,
  PBE_SHA1_3DES_2KEY,
  PBE_SHA1_RC2_128,
  PBE_SHA1_RC2_40,
]);

/** Algorithm config for each legacy PBE OID. */
function pbeConfig(oid: string): { keyLen: number; ivLen: number; algName: string } {
  switch (oid) {
    case PBE_SHA1_3DES_3KEY: return { keyLen: 24, ivLen: 8, algName: 'DES-EDE3-CBC' };
    case PBE_SHA1_3DES_2KEY: return { keyLen: 16, ivLen: 8, algName: 'DES-EDE3-CBC' };
    case PBE_SHA1_RC2_128:   return { keyLen: 16, ivLen: 8, algName: 'RC2-CBC' };
    case PBE_SHA1_RC2_40:    return { keyLen: 5,  ivLen: 8, algName: 'RC2-CBC' };
    default: throw new Error(`Unsupported legacy PBE OID: ${oid}`);
  }
}

/**
 * PKCS#12 key derivation - RFC 7292, Appendix B.
 *
 * @param password  BMP-encoded password (with trailing 0x00 0x00)
 * @param salt      raw salt bytes
 * @param iterations  PBKDF iteration count
 * @param id        1 = key material, 2 = IV, 3 = MAC key
 * @param needed    number of bytes to derive
 */
async function pkcs12KDF(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  id: number,
  needed: number,
): Promise<Uint8Array> {
  const v = 64; // SHA-1 block size
  const u = 20; // SHA-1 output size

  // Step 1: diversifier D = v bytes of 'id'
  const D = new Uint8Array(v);
  D.fill(id);

  // Step 2: fill S from salt, padded/repeated to v-byte boundary
  const sLen = salt.length === 0 ? 0 : v * Math.ceil(salt.length / v);
  const S = new Uint8Array(sLen);
  for (let i = 0; i < sLen; i++) S[i] = salt[i % salt.length];

  // Step 3: fill P from password, padded/repeated to v-byte boundary
  const pLen = password.length === 0 ? 0 : v * Math.ceil(password.length / v);
  const P = new Uint8Array(pLen);
  for (let i = 0; i < pLen; i++) P[i] = password[i % password.length];

  // I = S || P
  const I = new Uint8Array(sLen + pLen);
  I.set(S, 0);
  I.set(P, sLen);

  const c = Math.ceil(needed / u);
  const result = new Uint8Array(c * u);

  for (let i = 0; i < c; i++) {
    // Aj = Hash^iterations(D || I)
    const buf = new Uint8Array(v + I.length);
    buf.set(D, 0);
    buf.set(I, v);

    let A = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
    for (let j = 1; j < iterations; j++) {
      A = new Uint8Array(await crypto.subtle.digest('SHA-1', A));
    }

    result.set(A, i * u);

    if (i + 1 < c) {
      // Build B by repeating A to fill v bytes
      const B = new Uint8Array(v);
      for (let j = 0; j < v; j++) B[j] = A[j % u];

      // I[j] = (I[j] + B + 1) mod 2^v for each v-byte block
      for (let j = 0; j < I.length; j += v) {
        let carry = 1;
        for (let k = v - 1; k >= 0; k--) {
          const sum = I[j + k] + B[k] + carry;
          I[j + k] = sum & 0xff;
          carry = sum >> 8;
        }
      }
    }
  }

  return result.slice(0, needed);
}

/** Encode a password as BMP string with trailing NUL pair (RFC 7292 §B.1). */
function passwordToBMP(password: ArrayBuffer): Uint8Array {
  const passView = new Uint8Array(password);
  // If already BMP-encoded (even length, every odd byte is 0x00 for ASCII),
  // or empty, use as-is. Otherwise convert char codes to big-endian UCS-2.
  // pkijs passes the password as a raw ArrayBuffer of char codes.
  const bmp = new Uint8Array(passView.length * 2 + 2);
  for (let i = 0; i < passView.length; i++) {
    bmp[i * 2] = 0;
    bmp[i * 2 + 1] = passView[i];
  }
  // trailing 0x00 0x00
  bmp[bmp.length - 2] = 0;
  bmp[bmp.length - 1] = 0;
  return bmp;
}

// ── CMS content encryption OIDs (for EnvelopedData decryption) ─────
const OID_DES_EDE3_CBC = '1.2.840.113549.3.7'; // des-EDE3-CBC (3DES)
const OID_DES_CBC = '1.3.14.3.2.7';            // desCBC
const OID_RC2_CBC = '1.2.840.113549.3.2';      // rc2CBC

/**
 * Extended CryptoEngine that handles legacy algorithms (3DES, etc.)
 * not recognized by pkijs's default CryptoEngine.
 *
 * - Adds OID→algorithm mappings for DES-EDE3-CBC so that
 *   EnvelopedData.decrypt() can process 3DES-encrypted S/MIME messages.
 * - Handles legacy PKCS#12 PBE algorithms via custom KDF.
 */
class Pkcs12CryptoEngine extends pkijs.CryptoEngine {
  /**
   * Extend OID→algorithm mapping with legacy algorithms that webcrypto-liner
   * supports but pkijs does not know about.
   */
  getAlgorithmByOID(oid: string, safety?: boolean, target?: string): object {
    switch (oid) {
      case OID_DES_EDE3_CBC:
        return { name: 'DES-EDE3-CBC', length: 192 };
      case OID_DES_CBC:
        return { name: 'DES-CBC', length: 64 };
      case OID_RC2_CBC:
        return { name: 'RC2-CBC', length: 128 };
      default:
        return super.getAlgorithmByOID(oid, safety, target);
    }
  }

  getOIDByAlgorithm(algorithm: { name: string; length?: number }, safety?: boolean, target?: string): string {
    switch (algorithm.name.toUpperCase()) {
      case 'DES-EDE3-CBC':
        return OID_DES_EDE3_CBC;
      case 'DES-CBC':
        return OID_DES_CBC;
      case 'RC2-CBC':
        return OID_RC2_CBC;
      default:
        return super.getOIDByAlgorithm(algorithm, safety, target);
    }
  }

  async decryptEncryptedContentInfo(
    parameters: Parameters<pkijs.CryptoEngine['decryptEncryptedContentInfo']>[0],
  ): Promise<ArrayBuffer> {
    const oid = parameters.encryptedContentInfo.contentEncryptionAlgorithm.algorithmId;

    if (!LEGACY_PBE_OIDS.has(oid)) {
      // Delegate to base CryptoEngine (handles PBES2)
      return super.decryptEncryptedContentInfo(parameters);
    }

    const algParams = parameters.encryptedContentInfo.contentEncryptionAlgorithm.algorithmParams;
    if (!algParams) {
      throw new Error('Missing PBE algorithm parameters');
    }

    // Parse PBEParameter ::= SEQUENCE { salt OCTET STRING, iterationCount INTEGER }
    const paramAsn1 = asn1js.fromBER(algParams.toBER(false));
    if (paramAsn1.offset === -1) {
      throw new Error('Invalid PBE parameters ASN.1');
    }
    const seq = paramAsn1.result as asn1js.Sequence;
    const salt = new Uint8Array((seq.valueBlock.value[0] as asn1js.OctetString).valueBlock.valueHexView);
    const iterations = (seq.valueBlock.value[1] as asn1js.Integer).valueBlock.valueDec;

    const { keyLen, ivLen, algName } = pbeConfig(oid);
    const bmpPassword = passwordToBMP(parameters.password);

    // Derive key (id=1) and IV (id=2) using PKCS#12 KDF
    const keyBytes = await pkcs12KDF(bmpPassword, salt, iterations, 1, keyLen);
    const ivBytes = await pkcs12KDF(bmpPassword, salt, iterations, 2, ivLen);

    // Import key via webcrypto-liner (supports DES-EDE3-CBC)
    const keyData = new Uint8Array(keyBytes.buffer as ArrayBuffer, keyBytes.byteOffset, keyBytes.byteLength);
    const cryptoKey = await this.importKey(
      'raw',
      keyData,
      // eslint-disable-next-line no-undef
      { name: algName, length: keyLen * 8 } as Algorithm,
      false,
      ['decrypt'],
    );

    // Decrypt
    const ciphertext = parameters.encryptedContentInfo.getEncryptedContent();
    return this.decrypt(
      // eslint-disable-next-line no-undef
      { name: algName, iv: ivBytes } as Algorithm,
      cryptoKey,
      ciphertext,
    );
  }
}

let linerEngine: Pkcs12CryptoEngine | null = null;
let linerCryptoInstance: Crypto | null = null;

function ensureLiner() {
  if (!linerCryptoInstance) {
    // In Node.js, webcrypto-liner can't auto-detect the native crypto
    // (it looks for self.crypto which doesn't exist). Feed it manually
    // so that native algorithms (RSA, AES, etc.) stay hardware-accelerated
    // and only truly missing algorithms (3DES) use the software fallback.
    if (
      typeof liner.nativeCrypto?.getRandomValues !== 'function' &&
      typeof globalThis.crypto?.subtle !== 'undefined'
    ) {
      liner.setCrypto(globalThis.crypto.subtle);
    }
    linerCryptoInstance = new liner.Crypto();
  }
  if (!linerEngine) {
    linerEngine = new Pkcs12CryptoEngine({
      crypto: linerCryptoInstance,
      subtle: linerCryptoInstance.subtle,
      name: 'webcrypto-liner',
    });
  }
}

/** Get a PKI.js CryptoEngine with 3DES (and other legacy algorithm) support. */
export function getLinerCryptoEngine(): pkijs.CryptoEngine {
  ensureLiner();
  return linerEngine!;
}

/** Get the webcrypto-liner Crypto instance (for importKey with legacy algorithms). */
export function getLinerCrypto(): Crypto {
  ensureLiner();
  return linerCryptoInstance!;
}

/**
 * Run an async operation with the global PKI.js engine set to webcrypto-liner,
 * then restore the previous engine afterwards.
 *
 * Required for operations that use the global engine internally
 * (e.g. PFX.parseInternalValues for PKCS#12 import).
 */
export async function withLinerEngine<T>(fn: () => Promise<T>): Promise<T> {
  ensureLiner();

  // Save the current global engine so we can restore it
  const prev = pkijs.getEngine();

  pkijs.setEngine('webcrypto-liner', linerCryptoInstance!, linerEngine!);
  try {
    return await fn();
  } finally {
    // Restore the previous engine
    pkijs.setEngine(prev.name, prev.crypto as unknown as pkijs.CryptoEngine);
  }
}
