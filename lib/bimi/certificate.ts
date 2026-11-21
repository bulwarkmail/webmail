import { X509Certificate, verify as verifySignature } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  certificateExtensions,
  children,
  content,
  decodeOid,
  encoding,
  integerHex,
  normalizeSerial,
  readNode,
  stringsIn,
  type DerNode,
} from './der';

/**
 * Validation of a BIMI evidence document: the PEM chain of a Verified Mark
 * Certificate (VMC) or Common Mark Certificate (CMC), following
 * draft-fetch-validation-vmc-wchuang. The indicator shown is the SVG inside
 * the certificate, so a valid chain also fixes which logo appears.
 *
 * Not checked: the signatures on the embedded SCTs (that needs the CT log
 * list); the certificate only has to carry them.
 */

/** id-kp-BrandIndicatorforMessageIdentification */
export const BIMI_EKU = '1.3.6.1.5.5.7.3.31';
const LOGOTYPE_OID = '1.3.6.1.5.5.7.1.12';
const SCT_LIST_OID = '1.3.6.1.4.1.11129.2.4.2';
const CRL_DISTRIBUTION_POINTS_OID = '2.5.29.31';
const MARK_TYPE_OID = '1.3.6.1.4.1.53087.1.13';
const MAX_CHAIN = 6;
const MAX_SVG_BYTES = 64 * 1024;

export type MarkType = 'verified' | 'common';

export interface MarkCertificate {
  svg: string;
  /** VMC (registered or government mark) or CMC (prior use mark). */
  markType: MarkType;
  /** The organization the mark belongs to, from the certificate subject. */
  organization?: string;
  /** The issuing CA's organization. */
  issuer?: string;
  /** When the certificate expires (ms since the epoch). */
  notAfter: number;
}

export type CertificateCheck =
  | { ok: true; mark: MarkCertificate }
  | { ok: false; reason: string };

export interface CertificateOptions {
  /** Where the assertion record was found and its organizational domain. */
  domains: readonly string[];
  selector: string;
  roots: readonly X509Certificate[];
  now?: number;
  /**
   * Fetches a CRL. Null when it can't be had, which counts as not revoked:
   * like browsers, an unreachable CRL doesn't fail the check.
   */
  fetchCrl?: (url: string) => Promise<Uint8Array | null>;
}

const PEM_BEGIN = '-----BEGIN CERTIFICATE-----';
const PEM_END = '-----END CERTIFICATE-----';

/**
 * The certificates in a PEM bundle, each from a BEGIN line to the next END
 * line. Reads the text once: a BEGIN with no END after it ends the bundle.
 */
export function splitPem(pem: string): X509Certificate[] {
  const certificates: X509Certificate[] = [];
  let pos = 0;
  for (;;) {
    const begin = pem.indexOf(PEM_BEGIN, pos);
    if (begin === -1) break;
    const end = pem.indexOf(PEM_END, begin + PEM_BEGIN.length);
    if (end === -1) break;
    pos = end + PEM_END.length;
    certificates.push(new X509Certificate(pem.slice(begin, pos)));
  }
  return certificates;
}

function hasBimiEku(cert: X509Certificate): boolean {
  return Array.isArray(cert.keyUsage) && cert.keyUsage.includes(BIMI_EKU);
}

function within(cert: X509Certificate, now: number): boolean {
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  return Number.isFinite(from) && Number.isFinite(to) && from <= now && now <= to;
}

function issuedBy(cert: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

/** Values of one attribute in an X509Certificate subject or issuer string. */
function attribute(name: string, field: string): string | undefined {
  for (const line of name.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq) === field) return line.slice(eq + 1).replace(/\\(.)/g, '$1');
  }
  return undefined;
}

function sanDnsNames(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? '')
    .split(/,\s*/)
    .filter((entry) => entry.startsWith('DNS:'))
    .map((entry) => entry.slice(4).trim().toLowerCase().replace(/\.$/, ''));
}

/**
 * The SAN rule of the draft (section 5.2): names with a "_bimi" label pin a
 * selector, the others cover the default one.
 */
export function sanMatches(names: readonly string[], domains: readonly string[], selector: string): boolean {
  const selectorSet = names.filter((name) => name.split('.').includes('_bimi'));
  const domainSet = names.filter((name) => !name.split('.').includes('_bimi'));
  return domains.some((domain) => {
    const d = domain.toLowerCase();
    return selectorSet.includes(`${selector.toLowerCase()}._bimi.${d}`) || domainSet.includes(d);
  });
}

/** The SVG in the logotype extension: a data: URI holding gzip-compressed, base64-encoded SVG. */
export function logotypeSvg(extension: Uint8Array): string | null {
  for (const uri of stringsIn(extension, 0x16)) {
    const match = /^data:image\/svg\+xml(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(uri.trim());
    if (!match) continue;
    let bytes: Buffer = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      try {
        bytes = gunzipSync(bytes, { maxOutputLength: MAX_SVG_BYTES });
      } catch {
        return null;
      }
    }
    if (bytes.length === 0 || bytes.length > MAX_SVG_BYTES) return null;
    return bytes.toString('utf8');
  }
  return null;
}

function crlUrls(cert: X509Certificate): string[] {
  const value = certificateExtensions(new Uint8Array(cert.raw)).get(CRL_DISTRIBUTION_POINTS_OID);
  if (!value) return [];
  // GeneralName uniformResourceIdentifier is [6] IMPLICIT IA5String.
  return stringsIn(value, 0x86).filter((url) => /^https?:\/\//i.test(url));
}

const SIGNATURE_HASHES: Record<string, string> = {
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512',
};

function parseTime(buf: Uint8Array, node: DerNode): number {
  const text = Buffer.from(content(buf, node)).toString('latin1');
  const m = node.tag === 0x17
    ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
    : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (!m) return NaN;
  let year = Number(m[1]);
  if (node.tag === 0x17) year += year < 50 ? 2000 : 1900;
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export interface ParsedCrl {
  revoked: Set<string>;
  nextUpdate?: number;
}

/**
 * Read a DER CertificateList and check its signature with the issuer's key.
 * Null when it doesn't parse, uses an algorithm we don't know, or isn't
 * signed by `issuer`.
 */
export function parseCrl(der: Uint8Array, issuer: X509Certificate): ParsedCrl | null {
  try {
    const list = readNode(der, 0);
    const [tbs, algorithm, signature] = children(der, list);
    if (!tbs || !algorithm || !signature || signature.tag !== 0x03) return null;
    const algorithmOid = children(der, algorithm)[0];
    const hash = SIGNATURE_HASHES[decodeOid(content(der, algorithmOid))];
    if (!hash) return null;
    // BIT STRING: the first content byte counts the unused bits.
    const signatureBytes = content(der, signature).subarray(1);
    if (!verifySignature(hash, encoding(der, tbs), issuer.publicKey, signatureBytes)) return null;

    const fields = children(der, tbs);
    let i = fields[0]?.tag === 0x02 ? 1 : 0; // version
    i += 2; // signature algorithm, issuer
    i += 1; // thisUpdate
    let nextUpdate: number | undefined;
    if (fields[i] && (fields[i].tag === 0x17 || fields[i].tag === 0x18)) {
      nextUpdate = parseTime(der, fields[i]);
      i++;
    }
    const revoked = new Set<string>();
    if (fields[i]?.tag === 0x30) {
      for (const entry of children(der, fields[i])) {
        const serial = children(der, entry)[0];
        if (serial?.tag === 0x02) revoked.add(integerHex(content(der, serial)));
      }
    }
    return { revoked, nextUpdate };
  } catch {
    return null;
  }
}

async function isRevoked(
  cert: X509Certificate,
  issuer: X509Certificate,
  fetchCrl: NonNullable<CertificateOptions['fetchCrl']>,
  now: number,
): Promise<boolean> {
  const serial = normalizeSerial(cert.serialNumber);
  for (const url of crlUrls(cert)) {
    const der = await fetchCrl(url);
    if (!der) continue;
    const crl = parseCrl(der, issuer);
    // A stale CRL still lists what it lists; it just can't clear anything new.
    if (!crl) continue;
    if (crl.revoked.has(serial)) return true;
    if (crl.nextUpdate === undefined || crl.nextUpdate >= now) return false;
  }
  return false;
}

export async function validateMarkCertificate(pem: string, options: CertificateOptions): Promise<CertificateCheck> {
  const now = options.now ?? Date.now();
  let certs: X509Certificate[];
  try {
    certs = splitPem(pem);
  } catch {
    return { ok: false, reason: 'unparsable PEM' };
  }
  const leaves = certs.filter((cert) => !cert.ca && hasBimiEku(cert));
  if (leaves.length !== 1) return { ok: false, reason: leaves.length ? 'more than one mark certificate' : 'no mark certificate' };
  const leaf = leaves[0];

  // Walk up through the certificates the sender supplied until one is
  // signed by a pinned root's key. A root in the PEM itself proves nothing:
  // it can only ever be a step on the way, never the end.
  const chain = [leaf];
  let root: X509Certificate | undefined;
  while (!root && chain.length <= MAX_CHAIN) {
    const current = chain[chain.length - 1];
    root = options.roots.find((candidate) => issuedBy(current, candidate));
    if (root) break;
    const next = certs.find((cert) => cert.ca && !chain.includes(cert) && issuedBy(current, cert));
    if (!next) return { ok: false, reason: 'chain does not reach a trusted root' };
    chain.push(next);
  }
  if (!root) return { ok: false, reason: 'chain too long' };

  for (const cert of [...chain, root]) {
    if (!within(cert, now)) return { ok: false, reason: 'certificate outside its validity period' };
  }
  // The leaf and the CA that issued it both carry the BIMI key purpose.
  const issuing = chain[1] ?? root;
  if (!hasBimiEku(leaf) || (issuing !== root && !hasBimiEku(issuing))) return { ok: false, reason: 'missing BIMI key purpose' };

  if (!sanMatches(sanDnsNames(leaf), options.domains, options.selector)) return { ok: false, reason: 'domain not in certificate' };

  let extensions: Map<string, Uint8Array>;
  try {
    extensions = certificateExtensions(new Uint8Array(leaf.raw));
  } catch {
    return { ok: false, reason: 'unparsable certificate' };
  }
  if (!extensions.has(SCT_LIST_OID)) return { ok: false, reason: 'not logged to certificate transparency' };
  const logotype = extensions.get(LOGOTYPE_OID);
  let svg: string | null = null;
  try {
    svg = logotype ? logotypeSvg(logotype) : null;
  } catch {
    svg = null;
  }
  if (!svg) return { ok: false, reason: 'no logo in certificate' };

  if (options.fetchCrl) {
    const path = [...chain, root];
    for (let i = 0; i < chain.length; i++) {
      if (await isRevoked(path[i], path[i + 1], options.fetchCrl, now)) return { ok: false, reason: 'certificate revoked' };
    }
  }

  const markTypeName = attribute(leaf.subject, MARK_TYPE_OID);
  return {
    ok: true,
    mark: {
      svg,
      markType: markTypeName === 'Prior Use Mark' ? 'common' : 'verified',
      organization: attribute(leaf.subject, 'O'),
      issuer: attribute(leaf.issuer, 'O'),
      notAfter: Date.parse(leaf.validTo),
    },
  };
}
