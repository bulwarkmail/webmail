import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { decryptPrivateKeyBytes } from './pkcs12-import';
import type { SmimeKeyRecord } from './types';

function stringToArrayBuffer(str: string): ArrayBuffer {
  const buf = new ArrayBuffer(str.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) {
    view[i] = str.charCodeAt(i);
  }
  return buf;
}

/**
 * Export an S/MIME key record as a PKCS#12 (.p12) file.
 *
 * Flow:
 *  1. Decrypt the stored PKCS#8 private key bytes using the storage passphrase.
 *  2. Build a PKCS#12 container with the private key, leaf cert, and chain.
 *  3. Protect the PKCS#12 with the export passphrase.
 *  4. Return the resulting bytes for browser download.
 */
export async function exportPkcs12(
  record: SmimeKeyRecord,
  storagePassphrase: string,
  exportPassphrase: string,
): Promise<ArrayBuffer> {
  // Step 1: Decrypt the stored private key
  const pkcs8Bytes = await decryptPrivateKeyBytes(record, storagePassphrase);

  // Step 2: Parse the leaf certificate
  const leafCertAsn1 = asn1js.fromBER(record.certificate);
  if (leafCertAsn1.offset === -1) {
    throw new Error('Failed to parse leaf certificate');
  }
  const leafCert = new pkijs.Certificate({ schema: leafCertAsn1.result });

  // Parse chain certificates
  const chainCerts = record.certificateChain.map((chainDer) => {
    const chainAsn1 = asn1js.fromBER(chainDer);
    if (chainAsn1.offset === -1) {
      throw new Error('Failed to parse chain certificate');
    }
    return new pkijs.Certificate({ schema: chainAsn1.result });
  });

  const passwordBuf = stringToArrayBuffer(exportPassphrase);

  // Step 3: Build the PKCS#12 structure
  // Create key bag
  const keyBag = new pkijs.PKCS8ShroudedKeyBag({
    parsedValue: pkijs.PrivateKeyInfo.fromBER(pkcs8Bytes),
  });

  await keyBag.makeInternalValues({
    password: passwordBuf,
    contentEncryptionAlgorithm: {
      name: 'AES-CBC',
      length: 256,
    } as unknown as Parameters<typeof keyBag.makeInternalValues>[0]['contentEncryptionAlgorithm'],
    hmacHashAlgorithm: 'SHA-256',
    iterationCount: 100_000,
  });

  const keyBagSafe = new pkijs.SafeBag({
    bagId: '1.2.840.113549.1.12.10.1.2', // pkcs8ShroudedKeyBag
    bagValue: keyBag,
    bagAttributes: [
      new pkijs.Attribute({
        type: '1.2.840.113549.1.9.20', // friendlyName
        values: [new asn1js.BmpString({ value: record.email })],
      }),
    ],
  });

  // Create cert bags
  const certBags = [
    new pkijs.SafeBag({
      bagId: '1.2.840.113549.1.12.10.1.3', // certBag
      bagValue: new pkijs.CertBag({
        parsedValue: leafCert,
      }),
      bagAttributes: [
        new pkijs.Attribute({
          type: '1.2.840.113549.1.9.20',
          values: [new asn1js.BmpString({ value: record.email })],
        }),
      ],
    }),
    ...chainCerts.map(
      (cert) =>
        new pkijs.SafeBag({
          bagId: '1.2.840.113549.1.12.10.1.3',
          bagValue: new pkijs.CertBag({
            parsedValue: cert,
          }),
        }),
    ),
  ];

  // Build authenticated safe with two SafeContents:
  // 1. Key bag (password-encrypted)
  // 2. Cert bags (unencrypted)
  const authenticatedSafe = new pkijs.AuthenticatedSafe({
    parsedValue: {
      safeContents: [
        {
          privacyMode: 0, // no extra encryption - key bag is already shrouded
          value: new pkijs.SafeContents({
            safeBags: [keyBagSafe],
          }),
        },
        {
          privacyMode: 0,
          value: new pkijs.SafeContents({
            safeBags: certBags,
          }),
        },
      ],
    },
  });

  await authenticatedSafe.makeInternalValues({
    safeContents: [{}, {}],
  });

  const pfx = new pkijs.PFX({
    parsedValue: {
      integrityMode: 0,
      authenticatedSafe,
    },
  });

  await pfx.makeInternalValues({
    password: passwordBuf,
    iterations: 100_000,
    pbkdf2HashAlgorithm: 'SHA-256',
    hmacHashAlgorithm: 'SHA-256',
  });

  // Step 4: Serialize to DER
  return pfx.toSchema().toBER(false);
}

/** Trigger a browser download of the PKCS#12 file. */
export function downloadPkcs12(p12Bytes: ArrayBuffer, filename: string): void {
  const blob = new Blob([p12Bytes], { type: 'application/x-pkcs12' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
