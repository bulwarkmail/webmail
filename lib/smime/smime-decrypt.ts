/**
 * Decrypt CMS EnvelopedData to recover the inner MIME content.
 *
 * Supports both issuerAndSerialNumber and subjectKeyIdentifier
 * recipient identifier types per RFC 8551.
 */

import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import type { SmimeKeyRecord } from './types';
import { getLinerCryptoEngine, withLinerEngine } from './crypto-engine';

export interface DecryptionInput {
  /** Raw CMS EnvelopedData bytes (DER) */
  cmsBytes: ArrayBuffer;
  /** All imported key records to try matching against */
  keyRecords: SmimeKeyRecord[];
  /** Unlocked CryptoKey map: keyRecordId → CryptoKey (RSA-OAEP) */
  unlockedKeys: Map<string, CryptoKey>;
  /** Unlocked legacy CryptoKey map: keyRecordId → CryptoKey (RSAES-PKCS1-v1_5 via webcrypto-liner) */
  legacyUnlockedKeys?: Map<string, CryptoKey>;
}

export interface DecryptionResult {
  /** The decrypted inner MIME bytes */
  mimeBytes: Uint8Array;
  /** The key record that was used to decrypt */
  keyRecordId: string;
}

/**
 * Attempt to decrypt CMS EnvelopedData.
 *
 * Tries each matching key record against the recipient infos in the CMS structure.
 *
 * @throws Error if no matching key is found, key is locked, or decryption fails
 */
export async function smimeDecrypt(input: DecryptionInput): Promise<DecryptionResult> {
  const { cmsBytes, keyRecords, unlockedKeys, legacyUnlockedKeys } = input;

  // Parse the CMS ContentInfo wrapper
  const contentInfo = parseContentInfo(cmsBytes);
  const envelopedData = extractEnvelopedData(contentInfo);

  // Log CMS algorithm details for diagnostics
  const contentEncOid = envelopedData.encryptedContentInfo?.contentEncryptionAlgorithm?.algorithmId;
  const recipientAlgs = envelopedData.recipientInfos?.map((ri) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ri as any).value?.keyEncryptionAlgorithm?.algorithmId as string | undefined,
  );
  console.debug('[S/MIME] CMS algorithms:', {
    contentEncryption: contentEncOid,
    keyTransport: recipientAlgs,
    legacyKeysAvailable: legacyUnlockedKeys?.size ?? 0,
  });

  // Find matching key records
  const matchedRecords = findMatchingKeyRecords(envelopedData, keyRecords);

  if (matchedRecords.length === 0) {
    throw new Error('No imported S/MIME key matches any recipient in this encrypted message');
  }

  // Try each matched record
  for (const { keyRecord, recipientIndex } of matchedRecords) {
    const privateKey = unlockedKeys.get(keyRecord.id);
    if (!privateKey) {
      // Try legacy key (RSAES-PKCS1-v1_5) if no RSA-OAEP key
      const legacyKey = legacyUnlockedKeys?.get(keyRecord.id);
      if (legacyKey) {
        try {
          const decrypted = await decryptWithKey(envelopedData, recipientIndex, legacyKey, keyRecord);
          return {
            mimeBytes: new Uint8Array(decrypted),
            keyRecordId: keyRecord.id,
          };
        } catch {
          continue;
        }
      }
      continue; // Key exists but isn't unlocked - skip, caller should unlock first
    }

    try {
      const decrypted = await decryptWithKey(envelopedData, recipientIndex, privateKey, keyRecord);
      return {
        mimeBytes: new Uint8Array(decrypted),
        keyRecordId: keyRecord.id,
      };
    } catch (oaepError) {
      // RSA-OAEP key didn't work, try legacy RSAES-PKCS1-v1_5 key
      console.debug('[S/MIME] RSA-OAEP decrypt failed:', oaepError instanceof Error ? oaepError.message : oaepError);
      const legacyKey = legacyUnlockedKeys?.get(keyRecord.id);
      console.debug('[S/MIME] legacy key available:', !!legacyKey, legacyKey ? { algorithm: (legacyKey as CryptoKey).algorithm } : undefined);
      if (legacyKey) {
        try {
          const decrypted = await decryptWithKey(envelopedData, recipientIndex, legacyKey, keyRecord);
          return {
            mimeBytes: new Uint8Array(decrypted),
            keyRecordId: keyRecord.id,
          };
        } catch (legacyError) {
          // Legacy key also didn't work, try the next record
          console.debug('[S/MIME] RSAES-PKCS1-v1_5 decrypt also failed:', legacyError instanceof Error ? legacyError.message : legacyError);
        }
      }
      continue;
    }
  }

  // Check if we had matching records but none were unlocked
  const isUnlocked = (id: string) => unlockedKeys.has(id) || (legacyUnlockedKeys?.has(id) ?? false);
  const hasLockedMatch = matchedRecords.some(m => !isUnlocked(m.keyRecord.id));
  if (hasLockedMatch) {
    const lockedRecord = matchedRecords.find(m => !isUnlocked(m.keyRecord.id))!;
    throw new SmimeKeyLockedError(
      'S/MIME key is locked. Unlock it to decrypt this message.',
      lockedRecord.keyRecord.id,
    );
  }

  throw new Error('Failed to decrypt message with any available key');
}

/**
 * Get the key record IDs that could potentially decrypt a message.
 * Useful for prompting the user to unlock the right key.
 */
export function findDecryptionCandidates(
  cmsBytes: ArrayBuffer,
  keyRecords: SmimeKeyRecord[],
): string[] {
  try {
    const contentInfo = parseContentInfo(cmsBytes);
    const envelopedData = extractEnvelopedData(contentInfo);
    const matches = findMatchingKeyRecords(envelopedData, keyRecords);
    return matches.map(m => m.keyRecord.id);
  } catch {
    return [];
  }
}

export class SmimeKeyLockedError extends Error {
  constructor(
    message: string,
    public readonly keyRecordId: string,
  ) {
    super(message);
    this.name = 'SmimeKeyLockedError';
  }
}

// --- Internal helpers ---

/**
 * Normalize raw blob bytes into DER-encoded CMS data.
 *
 * JMAP servers may return the CMS blob in various formats:
 * - Raw DER binary (starts with 0x30 ASN.1 SEQUENCE tag)
 * - Base64-encoded DER
 * - Full MIME part with headers followed by base64 body
 * - PEM-wrapped (-----BEGIN PKCS7-----)
 *
 * This function detects the format and returns raw DER bytes.
 */
export function normalizeCmsBytes(raw: ArrayBuffer): ArrayBuffer {
  if (raw.byteLength === 0) {
    return raw;
  }

  const bytes = new Uint8Array(raw);

  // Already valid DER - starts with ASN.1 SEQUENCE tag
  if (bytes[0] === 0x30) {
    return raw;
  }

  let text = new TextDecoder().decode(raw);

  const looksMostlyText = (() => {
    const sample = text.slice(0, Math.min(text.length, 2048));
    if (sample.length === 0) return false;
    let printable = 0;
    for (let i = 0; i < sample.length; i++) {
      const code = sample.charCodeAt(i);
      if (
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0d ||
        (code >= 0x20 && code <= 0x7e)
      ) {
        printable++;
      }
    }
    return printable / sample.length > 0.85;
  })();

  // Check if the blob contains MIME headers (e.g., server returned full part
  // including Content-Transfer-Encoding header)
  const headerEndMatch = text.match(/\r?\n\r?\n/);
  const hasMimeHeaderHints = /content-type:|content-transfer-encoding:|mime-version:/i.test(text.slice(0, Math.min(text.length, 8192)));
  if (looksMostlyText && headerEndMatch && headerEndMatch.index !== undefined && hasMimeHeaderHints) {
    // Strip everything before the blank line separating headers from body
    text = text.substring(headerEndMatch.index + headerEndMatch[0].length);
  }

  // Strip PEM armour if present
  text = text
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, '')
    .replace(/-----END [A-Z0-9 ]+-----/g, '');

  // Remove all whitespace and try base64 decode
  text = text.replace(/\s/g, '');

  if (text.length === 0) {
    return raw;
  }

  try {
    const binary = atob(text);
    const decoded = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i);
    if (decoded.length > 0 && decoded[0] === 0x30) {
      return decoded.buffer as ArrayBuffer;
    }
  } catch { /* non-DER data, continue to fallback */ }

  // Fallback: parse explicit MIME base64 sections
  if (looksMostlyText) {
    const originalText = new TextDecoder().decode(raw);
    const sectionRegex = /content-transfer-encoding:\s*base64[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--[^\r\n]+|$)/ig;
    const sectionBlocks: string[] = [];
    let sectionMatch: RegExpExecArray | null = null;
    while ((sectionMatch = sectionRegex.exec(originalText)) !== null) {
      sectionBlocks.push(sectionMatch[1]);
    }

    for (const block of sectionBlocks) {
      const cleaned = block.replace(/\s/g, '');
      if (cleaned.length < 8 || !/^[A-Za-z0-9+/=]+$/.test(cleaned)) continue;
      try {
        const binary = atob(cleaned);
        const decoded = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i);
        if (decoded.length > 0 && decoded[0] === 0x30) {
          return decoded.buffer as ArrayBuffer;
        }
      } catch {
        // try next section
      }
    }

    // Last resort: find base64-like blocks and keep only DER-looking decodes
    const base64Blocks = originalText.match(/[A-Za-z0-9+/=\r\n]{128,}/g) || [];
    const cleaned = base64Blocks
      .map(block => block.replace(/\s/g, ''))
      .filter(block => block.length >= 128 && /^[A-Za-z0-9+/=]+$/.test(block));

    cleaned.sort((a, b) => b.length - a.length);

    for (const block of cleaned) {
      try {
        const binary = atob(block);
        const decoded = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i);
        if (decoded.length > 0 && decoded[0] === 0x30) {
          return decoded.buffer as ArrayBuffer;
        }
      } catch {
        // try next block
      }
    }
  }

  // Not decodable - return original bytes
  return raw;
}

function parseContentInfo(der: ArrayBuffer): pkijs.ContentInfo {
  const asn1 = asn1js.fromBER(der);
  if (asn1.offset === -1) {
    throw new Error('Invalid ASN.1 data - cannot parse CMS envelope');
  }
  try {
    return new pkijs.ContentInfo({ schema: asn1.result });
  } catch {
    throw new Error('Invalid ASN.1 data - cannot parse CMS envelope');
  }
}

function extractEnvelopedData(contentInfo: pkijs.ContentInfo): pkijs.EnvelopedData {
  // OID 1.2.840.113549.1.7.3 = enveloped-data
  if (contentInfo.contentType !== '1.2.840.113549.1.7.3') {
    throw new Error(`Unexpected CMS content type: ${contentInfo.contentType}`);
  }
  return new pkijs.EnvelopedData({ schema: contentInfo.content });
}

interface RecipientMatch {
  keyRecord: SmimeKeyRecord;
  recipientIndex: number;
}

function findMatchingKeyRecords(
  envelopedData: pkijs.EnvelopedData,
  keyRecords: SmimeKeyRecord[],
): RecipientMatch[] {
  const matches: RecipientMatch[] = [];

  for (let i = 0; i < envelopedData.recipientInfos.length; i++) {
    const ri = envelopedData.recipientInfos[i];

    // RecipientInfo is a wrapper: variant=1 → KeyTransRecipientInfo
    const ktri = ri instanceof pkijs.KeyTransRecipientInfo
      ? ri
      : (ri as { variant?: number; value?: unknown }).variant === 1 && (ri as { value?: unknown }).value instanceof pkijs.KeyTransRecipientInfo
        ? (ri as { value: pkijs.KeyTransRecipientInfo }).value
        : null;

    if (ktri) {
      for (const keyRecord of keyRecords) {
        if (matchesKeyTransRecipient(ktri, keyRecord)) {
          matches.push({ keyRecord, recipientIndex: i });
        }
      }
    }
  }

  return matches;
}

function matchesKeyTransRecipient(
  recipientInfo: pkijs.KeyTransRecipientInfo,
  keyRecord: SmimeKeyRecord,
): boolean {
  const rid = recipientInfo.rid;

  // IssuerAndSerialNumber matching
  if (rid instanceof pkijs.IssuerAndSerialNumber) {
    try {
      const certAsn1 = asn1js.fromBER(keyRecord.certificate);
      if (certAsn1.offset === -1) return false;
      const cert = new pkijs.Certificate({ schema: certAsn1.result });

      // Compare serial numbers
      const ridSerial = Buffer.from(rid.serialNumber.valueBlock.valueHexView).toString('hex');
      const certSerial = Buffer.from(cert.serialNumber.valueBlock.valueHexView).toString('hex');
      if (ridSerial !== certSerial) return false;

      // Compare issuers (compare DER encoding)
      const ridIssuerDer = rid.issuer.toSchema().toBER(false);
      const certIssuerDer = cert.issuer.toSchema().toBER(false);
      return arraysEqual(new Uint8Array(ridIssuerDer), new Uint8Array(certIssuerDer));
    } catch {
      return false;
    }
  }

  // SubjectKeyIdentifier matching
  if (rid instanceof asn1js.OctetString) {
    try {
      const certAsn1 = asn1js.fromBER(keyRecord.certificate);
      if (certAsn1.offset === -1) return false;
      const cert = new pkijs.Certificate({ schema: certAsn1.result });

      // Find the SubjectKeyIdentifier extension
      const skiExt = cert.extensions?.find(
        ext => ext.extnID === '2.5.29.14', // id-ce-subjectKeyIdentifier
      );
      if (!skiExt) return false;

      const skiValue = asn1js.fromBER(skiExt.extnValue.valueBlock.valueHexView);
      if (skiValue.offset === -1) return false;
      const ski = (skiValue.result as asn1js.OctetString).valueBlock.valueHexView;

      return arraysEqual(
        new Uint8Array(ski),
        new Uint8Array(rid.valueBlock.valueHexView),
      );
    } catch {
      return false;
    }
  }

  return false;
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function decryptWithKey(
  envelopedData: pkijs.EnvelopedData,
  recipientIndex: number,
  privateKey: CryptoKey,
  keyRecord: SmimeKeyRecord,
): Promise<ArrayBuffer> {
  // Parse the certificate for pkijs
  const certAsn1 = asn1js.fromBER(keyRecord.certificate);
  const cert = new pkijs.Certificate({ schema: certAsn1.result });

  // Use withLinerEngine to set the global pkijs engine to webcrypto-liner.
  // This is required because pkijs internally may use getEngine() for
  // OID lookups and crypto operations. Without this, 3DES-encrypted
  // messages fail because the default engine doesn't know about DES-EDE3-CBC.
  return withLinerEngine(async () => {
    const cryptoEngine = getLinerCryptoEngine();

    return envelopedData.decrypt(
      recipientIndex,
      {
        recipientCertificate: cert,
        recipientPrivateKey: privateKey,
      },
      cryptoEngine,
    );
  });
}
