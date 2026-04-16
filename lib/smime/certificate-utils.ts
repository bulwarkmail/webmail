import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { Convert } from 'pvtsutils';
import type { CertificateInfo, SmimeKeyCapabilities } from './types';

/** OID for id-kp-emailProtection (S/MIME) */
const OID_EMAIL_PROTECTION = '1.3.6.1.5.5.7.3.4';

/** OID for SubjectAlternativeName */
const OID_SAN = '2.5.29.17';

// ── PEM/DER conversions ──────────────────────────────────────────────

export function pemToDer(pem: string): ArrayBuffer {
  const lines = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s/g, '');
  return Convert.FromBase64(lines);
}

export function derToPem(der: ArrayBuffer, label: string): string {
  const b64 = Convert.ToBase64(der);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

export function isPem(data: string): boolean {
  return /-----BEGIN (CERTIFICATE|PKCS12|ENCRYPTED PRIVATE KEY|PRIVATE KEY)-----/.test(data);
}

// ── Certificate parsing ──────────────────────────────────────────────

export function parseCertificateDer(der: ArrayBuffer): pkijs.Certificate {
  const asn1 = asn1js.fromBER(der);
  if (asn1.offset === -1) {
    throw new Error('Invalid DER data: ASN.1 parsing failed');
  }
  return new pkijs.Certificate({ schema: asn1.result });
}

export function parseCertificatePemOrDer(data: ArrayBuffer | string): pkijs.Certificate {
  if (typeof data === 'string') {
    if (isPem(data)) {
      return parseCertificateDer(pemToDer(data));
    }
    throw new Error('String input is not PEM-encoded');
  }
  // ArrayBuffer might contain PEM text rather than DER binary
  // PEM files start with "-----BEGIN " (0x2D 0x2D 0x2D 0x2D 0x2D 0x42)
  const header = new Uint8Array(data, 0, Math.min(20, data.byteLength));
  const maybePem = String.fromCharCode(...header);
  if (maybePem.startsWith('-----BEGIN ')) {
    const text = new TextDecoder().decode(data);
    return parseCertificateDer(pemToDer(text));
  }
  return parseCertificateDer(data);
}

// ── Metadata extraction ──────────────────────────────────────────────

function rdnToString(rdn: pkijs.RelativeDistinguishedNames): string {
  return rdn.typesAndValues
    .map((tv) => {
      const oid = tv.type;
      const val = tv.value.valueBlock.value;
      const name = oidToName(oid);
      return `${name}=${val}`;
    })
    .join(', ');
}

function oidToName(oid: string): string {
  const map: Record<string, string> = {
    '2.5.4.3': 'CN',
    '2.5.4.6': 'C',
    '2.5.4.7': 'L',
    '2.5.4.8': 'ST',
    '2.5.4.10': 'O',
    '2.5.4.11': 'OU',
    '1.2.840.113549.1.9.1': 'E',
  };
  return map[oid] ?? oid;
}

export async function computeFingerprint(der: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(der));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}

function extractAlgorithm(cert: pkijs.Certificate): string {
  const algOid = cert.subjectPublicKeyInfo.algorithm.algorithmId;
  // RSA
  if (algOid === '1.2.840.113549.1.1.1') {
    const pubKey = cert.subjectPublicKeyInfo;
    try {
      const asn1Pub = asn1js.fromBER(pubKey.subjectPublicKey.valueBlock.valueHexView);
      const seq = asn1Pub.result as asn1js.Sequence;
      const modulus = seq.valueBlock.value[0] as asn1js.Integer;
      const bitLen = (modulus.valueBlock.valueHexView.byteLength - 1) * 8;
      return `RSA-${bitLen}`;
    } catch {
      return 'RSA';
    }
  }
  // ECDSA
  if (algOid === '1.2.840.10045.2.1') {
    const params = cert.subjectPublicKeyInfo.algorithm.algorithmParams;
    if (params instanceof asn1js.ObjectIdentifier) {
      const curveOid = params.valueBlock.toString();
      const curves: Record<string, string> = {
        '1.2.840.10045.3.1.7': 'ECDSA-P256',
        '1.3.132.0.34': 'ECDSA-P384',
        '1.3.132.0.35': 'ECDSA-P521',
      };
      return curves[curveOid] ?? 'ECDSA';
    }
    return 'ECDSA';
  }
  return algOid;
}

function extractKeyUsage(cert: pkijs.Certificate): string[] | undefined {
  const ext = cert.extensions?.find((e) => e.extnID === '2.5.29.15');
  if (!ext?.parsedValue) return undefined;
  const ku = ext.parsedValue as {
    digitalSignature?: boolean;
    contentCommitment?: boolean;
    keyEncipherment?: boolean;
    dataEncipherment?: boolean;
    keyAgreement?: boolean;
    keyCertSign?: boolean;
    cRLSign?: boolean;
    encipherOnly?: boolean;
    decipherOnly?: boolean;
  };
  const names: string[] = [];
  if (ku.digitalSignature) names.push('digitalSignature');
  if (ku.contentCommitment) names.push('contentCommitment');
  if (ku.keyEncipherment) names.push('keyEncipherment');
  if (ku.dataEncipherment) names.push('dataEncipherment');
  if (ku.keyAgreement) names.push('keyAgreement');
  if (ku.keyCertSign) names.push('keyCertSign');
  if (ku.cRLSign) names.push('cRLSign');
  if (ku.encipherOnly) names.push('encipherOnly');
  if (ku.decipherOnly) names.push('decipherOnly');
  return names;
}

function extractExtendedKeyUsage(cert: pkijs.Certificate): string[] | undefined {
  const ext = cert.extensions?.find((e) => e.extnID === '2.5.29.37');
  if (!ext?.parsedValue) return undefined;
  const eku = ext.parsedValue as pkijs.ExtKeyUsage;
  return eku.keyPurposes;
}

function extractEmailAddresses(cert: pkijs.Certificate): string[] {
  const emails: string[] = [];

  // From subject emailAddress attribute
  for (const tv of cert.subject.typesAndValues) {
    if (tv.type === '1.2.840.113549.1.9.1') {
      emails.push(tv.value.valueBlock.value as string);
    }
  }

  // From SubjectAlternativeName
  const sanExt = cert.extensions?.find((e) => e.extnID === OID_SAN);
  if (sanExt) {
    let names: pkijs.GeneralName[] | undefined;

    // parsedValue may be a GeneralNames with .names, or a raw ASN.1 object
    const pv = sanExt.parsedValue as pkijs.GeneralNames | undefined;
    if (pv?.names) {
      names = pv.names;
    } else if (sanExt.extnValue) {
      // Manually parse the extension value as a SEQUENCE OF GeneralName
      try {
        const sanAsn1 = asn1js.fromBER(sanExt.extnValue.valueBlock.valueHexView);
        if (sanAsn1.offset !== -1) {
          const gn = new pkijs.GeneralNames({ schema: sanAsn1.result });
          names = gn.names;
        }
      } catch {
        // Malformed SAN - skip gracefully
      }
    }

    if (names) {
      for (const name of names) {
        // type 1 = rfc822Name
        if (name.type === 1 && typeof name.value === 'string') {
          if (!emails.includes(name.value)) {
            emails.push(name.value);
          }
        }
      }
    }
  }

  return emails;
}

/** Determine signing/encryption capabilities from KU / EKU. Tolerant of absent extensions. */
export function classifyCapabilities(cert: pkijs.Certificate): SmimeKeyCapabilities {
  const ku = extractKeyUsage(cert);
  const eku = extractExtendedKeyUsage(cert);

  let canSign = true;
  let canEncrypt = true;

  // If KeyUsage is present, check explicit bits
  if (ku) {
    canSign = ku.includes('digitalSignature') || ku.includes('contentCommitment');
    canEncrypt = ku.includes('keyEncipherment') || ku.includes('dataEncipherment') || ku.includes('keyAgreement');
  }

  // If EKU is present, only reject if it explicitly excludes emailProtection
  if (eku && eku.length > 0) {
    const hasEmailProtection = eku.includes(OID_EMAIL_PROTECTION);
    // Only restrict if EKU is present and does NOT include emailProtection
    if (!hasEmailProtection) {
      canSign = false;
      canEncrypt = false;
    }
  }

  return { canSign, canEncrypt };
}

/** Extract full metadata from a parsed certificate. */
export async function extractCertificateInfo(
  cert: pkijs.Certificate,
  der: ArrayBuffer,
): Promise<CertificateInfo> {
  const fingerprint = await computeFingerprint(der);
  const ku = extractKeyUsage(cert);
  const eku = extractExtendedKeyUsage(cert);
  const capabilities = classifyCapabilities(cert);

  return {
    subject: rdnToString(cert.subject),
    issuer: rdnToString(cert.issuer),
    serialNumber: cert.serialNumber.valueBlock.valueHexView
      ? Array.from(new Uint8Array(cert.serialNumber.valueBlock.valueHexView))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(':')
      : cert.serialNumber.valueBlock.toString(),
    notBefore: cert.notBefore.value.toISOString(),
    notAfter: cert.notAfter.value.toISOString(),
    fingerprint,
    algorithm: extractAlgorithm(cert),
    keyUsage: ku,
    extendedKeyUsage: eku,
    emailAddresses: extractEmailAddresses(cert),
    capabilities,
  };
}
