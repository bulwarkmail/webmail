import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { generateUUID } from '@/lib/utils';
import {
  extractCertificateInfo,
  classifyCapabilities,
} from './certificate-utils';
import type { SmimeKeyRecord, Pkcs12ImportResult } from './types';
import { withLinerEngine, getLinerCrypto } from './crypto-engine';

const KDF_ITERATIONS = 600_000;
const AES_KEY_LENGTH = 256;

function stringToAB(str: string): ArrayBuffer {
  const buf = new ArrayBuffer(str.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) {
    view[i] = str.charCodeAt(i);
  }
  return buf;
}

/** Parse a PKCS#12 (.p12/.pfx) file and produce an encrypted-at-rest key record. */
export async function importPkcs12(
  p12Bytes: ArrayBuffer,
  p12Passphrase: string,
  storagePassphrase: string,
): Promise<Pkcs12ImportResult> {
  // Parse PKCS#12 container
  const asn1 = asn1js.fromBER(p12Bytes);
  if (asn1.offset === -1) {
    throw new Error('Invalid PKCS#12 file: ASN.1 parsing failed');
  }

  const pfx = new pkijs.PFX({ schema: asn1.result });

  // Verify MAC if present
  if (pfx.macData) {
    // PKIjs handles MAC verification internally during parseInternalValues
  }

  // Use webcrypto-liner as the global engine for 3DES support.
  // Many PKCS#12 files use pbeWithSHAAnd3-KeyTripleDES-CBC internally.
  await withLinerEngine(async () => {
    await pfx.parseInternalValues({
      password: stringToAB(p12Passphrase),
    });
  });

  // Extract certificates and private key from parsed PKCS#12
  let leafCertDer: ArrayBuffer | null = null;
  let leafCert: pkijs.Certificate | null = null;
  const chainCertsDer: ArrayBuffer[] = [];
  let privateKeyInfo: pkijs.PrivateKeyInfo | null = null;

  if (!pfx.parsedValue?.authenticatedSafe) {
    throw new Error('PKCS#12 file does not contain an authenticated safe');
  }

  // Parse the authenticated safe contents (inner SafeContents)
  const authSafe = pfx.parsedValue.authenticatedSafe;
  const safeContentsParams = authSafe.safeContents.map((ci: pkijs.ContentInfo) => {
    // encryptedData (1.2.840.113549.1.7.6) needs the password
    if (ci.contentType === '1.2.840.113549.1.7.6') {
      return { password: stringToAB(p12Passphrase) };
    }
    return {};
  });
  await withLinerEngine(async () => {
    await authSafe.parseInternalValues({ safeContents: safeContentsParams });
  });

  for (const safeContent of authSafe.parsedValue.safeContents) {
    const sc = safeContent.value ?? safeContent.parsedValue;
    if (!sc) continue;

    for (const safeBag of sc.safeBags) {
      // PKCS#12 bag types
      switch (safeBag.bagId) {
        case '1.2.840.113549.1.12.10.1.3': {
          // CertBag
          const certBag = safeBag.bagValue as pkijs.CertBag;

          // parsedValue may already be a Certificate (built in-memory)
          let cert: pkijs.Certificate | null = null;
          let der: ArrayBuffer | null = null;

          if (certBag.parsedValue instanceof pkijs.Certificate) {
            cert = certBag.parsedValue;
            der = cert.toSchema(true).toBER(false);
          } else if (certBag.certId === '1.2.840.113549.1.9.22.1' && certBag.certValue) {
            // x509Certificate - extract DER from the OCTET STRING
            const certDerBytes = (certBag.certValue as asn1js.OctetString).valueBlock.valueHexView;
            const certAsn1 = asn1js.fromBER(certDerBytes);
            if (certAsn1.offset !== -1) {
              cert = new pkijs.Certificate({ schema: certAsn1.result });
              der = new Uint8Array(certDerBytes).buffer as ArrayBuffer;
            }
          }

          if (cert && der) {
            if (!leafCertDer) {
              leafCertDer = der;
              leafCert = cert;
            } else {
              chainCertsDer.push(der);
            }
          }
          break;
        }
        case '1.2.840.113549.1.12.10.1.1': {
          // KeyBag (unencrypted private key)
          privateKeyInfo = safeBag.bagValue as pkijs.PrivateKeyInfo;
          break;
        }
        case '1.2.840.113549.1.12.10.1.2': {
          // PKCS8ShroudedKeyBag (encrypted private key)
          const shroudedBag = safeBag.bagValue as pkijs.PKCS8ShroudedKeyBag;
          if (shroudedBag.parsedValue) {
            privateKeyInfo = shroudedBag.parsedValue;
          } else {
            // Decrypt shrouded key bag to get private key info
            await withLinerEngine(async () => {
              await (shroudedBag as unknown as { parseInternalValues(params: { password: ArrayBuffer }): Promise<void> }).parseInternalValues({
                password: stringToAB(p12Passphrase),
              });
            });
            if (shroudedBag.parsedValue) {
              privateKeyInfo = shroudedBag.parsedValue;
            }
          }
          break;
        }
      }
    }
  }

  if (!leafCert || !leafCertDer) {
    throw new Error('No certificate found in PKCS#12 file');
  }
  if (!privateKeyInfo) {
    throw new Error('No private key found in PKCS#12 file');
  }

  // Extract PKCS#8 private key bytes
  const pkcs8Bytes = privateKeyInfo.toSchema().toBER(false);

  // Encrypt the private key for at-rest storage
  const { encrypted, salt, iv } = await encryptPrivateKey(pkcs8Bytes, storagePassphrase);

  // Extract certificate metadata
  const certInfo = await extractCertificateInfo(leafCert, leafCertDer);
  const capabilities = classifyCapabilities(leafCert);

  const email = certInfo.emailAddresses[0] ?? '';

  const keyRecord: SmimeKeyRecord = {
    id: generateUUID(),
    email: email.toLowerCase(),
    certificate: leafCertDer,
    certificateChain: chainCertsDer,
    encryptedPrivateKey: encrypted,
    salt,
    iv,
    kdfIterations: KDF_ITERATIONS,
    issuer: certInfo.issuer,
    subject: certInfo.subject,
    serialNumber: certInfo.serialNumber,
    notBefore: certInfo.notBefore,
    notAfter: certInfo.notAfter,
    fingerprint: certInfo.fingerprint,
    algorithm: certInfo.algorithm,
    capabilities,
  };

  return { keyRecord, certInfo };
}

// ── Private key encryption / decryption ──────────────────────────────

async function deriveWrappingKey(
  passphrase: string,
  salt: ArrayBuffer,
  iterations: number,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptPrivateKey(
  pkcs8Bytes: ArrayBuffer,
  passphrase: string,
): Promise<{ encrypted: ArrayBuffer; salt: ArrayBuffer; iv: ArrayBuffer }> {
  const salt = crypto.getRandomValues(new Uint8Array(32)).buffer;
  const iv = crypto.getRandomValues(new Uint8Array(12)).buffer;
  const wrappingKey = await deriveWrappingKey(passphrase, salt, KDF_ITERATIONS);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    pkcs8Bytes,
  );
  return { encrypted, salt, iv };
}

export interface UnlockedKeyPair {
  signingKey: CryptoKey;
  decryptionKey?: CryptoKey;
  /** Key imported via webcrypto-liner as RSAES-PKCS1-v1_5 for legacy S/MIME (3DES) messages */
  legacyDecryptionKey?: CryptoKey;
}

/** Decrypt stored PKCS#8 bytes and import as non-extractable CryptoKeys for signing and decryption. */
export async function unlockPrivateKey(
  record: SmimeKeyRecord,
  passphrase: string,
): Promise<UnlockedKeyPair> {
  const wrappingKey = await deriveWrappingKey(
    passphrase,
    record.salt,
    record.kdfIterations,
  );

  let pkcs8Bytes: ArrayBuffer;
  try {
    pkcs8Bytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv },
      wrappingKey,
      record.encryptedPrivateKey,
    );
  } catch {
    throw new Error('Incorrect passphrase');
  }

  const isEcdsa = record.algorithm.startsWith('ECDSA');
  const signAlg = isEcdsa
    ? { name: 'ECDSA', namedCurve: ecdsaCurveFromAlg(record.algorithm) }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const decryptAlg = isEcdsa
    ? { name: 'ECDH', namedCurve: ecdsaCurveFromAlg(record.algorithm) }
    : { name: 'RSA-OAEP', hash: 'SHA-256' };
  const decryptUsages: globalThis.KeyUsage[] = isEcdsa ? ['deriveBits'] : ['decrypt'];

  // Import for signing
  let signingKey: CryptoKey;
  try {
    signingKey = await crypto.subtle.importKey('pkcs8', pkcs8Bytes, signAlg, false, ['sign']);
  } catch {
    // Key may only support decryption (key-encipherment-only cert)
    const decryptionKey = await crypto.subtle.importKey('pkcs8', pkcs8Bytes, decryptAlg, false, decryptUsages);
    let legacyDecryptionKey: CryptoKey | undefined;
    if (!isEcdsa) {
      try {
        const linerCrypto = getLinerCrypto();
        legacyDecryptionKey = await linerCrypto.subtle.importKey(
          'pkcs8',
          pkcs8Bytes,
          { name: 'RSAES-PKCS1-v1_5' },
          false,
          ['decrypt'],
        );
      } catch {
        // webcrypto-liner may not be available
      }
    }
    return { signingKey: decryptionKey, decryptionKey, legacyDecryptionKey };
  }

  // Also import for decryption (separate CryptoKey handle required by Web Crypto)
  let decryptionKey: CryptoKey | undefined;
  try {
    decryptionKey = await crypto.subtle.importKey('pkcs8', pkcs8Bytes, decryptAlg, false, decryptUsages);
  } catch {
    // Key may only support signing (digitalSignature-only cert)
  }

  // Import a legacy decryption key via webcrypto-liner for RSAES-PKCS1-v1_5 key transport
  // (used by older S/MIME messages encrypted with 3DES, RC2, etc.)
  let legacyDecryptionKey: CryptoKey | undefined;
  if (!isEcdsa) {
    try {
      const linerCrypto = getLinerCrypto();
      legacyDecryptionKey = await linerCrypto.subtle.importKey(
        'pkcs8',
        pkcs8Bytes,
        { name: 'RSAES-PKCS1-v1_5' },
        false,
        ['decrypt'],
      );
      console.debug('[S/MIME] legacy RSAES-PKCS1-v1_5 key imported successfully:', {
        algorithm: legacyDecryptionKey.algorithm,
        usages: legacyDecryptionKey.usages,
      });
    } catch (err) {
      console.warn('[S/MIME] legacy RSAES-PKCS1-v1_5 key import failed:', err);
    }
  }

  return { signingKey, decryptionKey, legacyDecryptionKey };
}

/** Get decrypted PKCS#8 bytes (for export flow). */
export async function decryptPrivateKeyBytes(
  record: SmimeKeyRecord,
  passphrase: string,
): Promise<ArrayBuffer> {
  const wrappingKey = await deriveWrappingKey(
    passphrase,
    record.salt,
    record.kdfIterations,
  );

  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv },
      wrappingKey,
      record.encryptedPrivateKey,
    );
  } catch {
    throw new Error('Incorrect passphrase');
  }
}

function ecdsaCurveFromAlg(alg: string): string {
  if (alg.includes('P256') || alg.includes('P-256')) return 'P-256';
  if (alg.includes('P384') || alg.includes('P-384')) return 'P-384';
  if (alg.includes('P521') || alg.includes('P-521')) return 'P-521';
  return 'P-256';
}
