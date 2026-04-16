/**
 * Verify CMS SignedData (opaque signed) and extract the inner content.
 *
 * Performs cryptographic signature validation, cert validity checks,
 * and trust-chain verification.
 */

import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { extractCertificateInfo } from './certificate-utils';
import type { SmimeStatus, SmimePublicCert } from './types';

export interface VerificationResult {
  /** The inner MIME bytes extracted from the opaque SignedData */
  mimeBytes: Uint8Array;
  /** Full S/MIME status for display */
  status: SmimeStatus;
}

/**
 * Verify a CMS SignedData structure and extract the encapsulated content.
 *
 * @param cmsBytes - Raw DER-encoded CMS SignedData
 * @param fromHeader - The From header email address for signer identity matching
 */
export async function smimeVerify(
  cmsBytes: ArrayBuffer,
  fromHeader?: string,
): Promise<VerificationResult> {
  const contentInfo = parseContentInfo(cmsBytes);
  const signedData = extractSignedData(contentInfo);

  // Extract inner content
  const innerContent = extractInnerContent(signedData);

  // Extract signer certificate
  const signerCert = extractSignerCertificate(signedData);
  if (!signerCert) {
    return {
      mimeBytes: innerContent,
      status: {
        isSigned: true,
        isEncrypted: false,
        signatureValid: false,
        signatureError: 'Signer certificate not found in CMS structure',
      },
    };
  }

  // Verify the signature cryptographically
  let signatureValid = false;
  let signatureError: string | undefined;

  try {
    const cryptoEngine = new pkijs.CryptoEngine({
      crypto: crypto,
      subtle: crypto.subtle,
      name: 'webcrypto',
    });

    const verifyResult = await signedData.verify(
      {
        signer: 0,
        checkChain: true,
      },
      cryptoEngine,
    );
    signatureValid = verifyResult;
  } catch (err) {
    signatureError = err instanceof Error ? err.message : 'Signature verification failed';
  }

  // Extract certificate info for display
  const certDer = signerCert.toSchema(true).toBER(false);
  const certInfo = await extractCertificateInfo(signerCert, certDer);

  // Check certificate validity period
  const now = new Date();
  const notBefore = new Date(certInfo.notBefore);
  const notAfter = new Date(certInfo.notAfter);
  const certExpired = now > notAfter;
  const certNotYetValid = now < notBefore;

  if (certExpired && !signatureError) {
    signatureError = 'Signer certificate has expired';
  }
  if (certNotYetValid && !signatureError) {
    signatureError = 'Signer certificate is not yet valid';
  }

  // Build the signer public cert object
  const signerEmail = certInfo.emailAddresses[0] ?? '';
  const signerPublicCert: SmimePublicCert = {
    id: `signer-${certInfo.fingerprint}`,
    email: signerEmail.toLowerCase(),
    certificate: certDer,
    issuer: certInfo.issuer,
    subject: certInfo.subject,
    notBefore: certInfo.notBefore,
    notAfter: certInfo.notAfter,
    fingerprint: certInfo.fingerprint,
    source: 'signed-email',
  };

  // Check signer identity vs From header
  let signerEmailMatch: boolean | undefined;
  if (fromHeader && signerEmail) {
    signerEmailMatch = fromHeader.toLowerCase() === signerEmail.toLowerCase();
  }

  // Detect self-signed certificates (issuer === subject)
  const issuerDer = new Uint8Array(signerCert.issuer.toSchema().toBER(false));
  const subjectDer = new Uint8Array(signerCert.subject.toSchema().toBER(false));
  const selfSigned = arraysEqual(issuerDer, subjectDer);

  return {
    mimeBytes: innerContent,
    status: {
      isSigned: true,
      isEncrypted: false,
      signatureValid: signatureValid && !certExpired && !certNotYetValid,
      signatureError,
      signerCert: signerPublicCert,
      signerEmailMatch,
      selfSigned,
    },
  };
}

// --- Internal helpers ---

function parseContentInfo(der: ArrayBuffer): pkijs.ContentInfo {
  const asn1 = asn1js.fromBER(der);
  if (asn1.offset === -1) {
    throw new Error('Invalid ASN.1 data - cannot parse CMS structure');
  }
  return new pkijs.ContentInfo({ schema: asn1.result });
}

function extractSignedData(contentInfo: pkijs.ContentInfo): pkijs.SignedData {
  // OID 1.2.840.113549.1.7.2 = signed-data
  if (contentInfo.contentType !== '1.2.840.113549.1.7.2') {
    throw new Error(`Unexpected CMS content type: ${contentInfo.contentType}`);
  }
  return new pkijs.SignedData({ schema: contentInfo.content });
}

function extractInnerContent(signedData: pkijs.SignedData): Uint8Array {
  const eContent = signedData.encapContentInfo?.eContent;
  if (!eContent) {
    throw new Error('No encapsulated content in SignedData (detached signature not supported)');
  }

  if (eContent instanceof asn1js.OctetString) {
    // Constructed OCTET STRING: data lives in child OctetStrings
    const children = (eContent.valueBlock as unknown as { value?: asn1js.OctetString[] }).value;
    if (children?.length) {
      const chunks = children.map(c => new Uint8Array(c.valueBlock.valueHexView));
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    }
    // Primitive OCTET STRING: data is directly in valueHexView
    return new Uint8Array(eContent.valueBlock.valueHexView);
  }

  throw new Error('Unable to extract content from SignedData');
}

function extractSignerCertificate(signedData: pkijs.SignedData): pkijs.Certificate | null {
  if (!signedData.signerInfos?.length || !signedData.certificates?.length) {
    return null;
  }

  const signerInfo = signedData.signerInfos[0];
  const sid = signerInfo.sid;

  // IssuerAndSerialNumber matching
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    for (const certItem of signedData.certificates) {
      if (!(certItem instanceof pkijs.Certificate)) continue;
      const cert = certItem;

      // Compare serial numbers
      const sidSerial = toHex(sid.serialNumber.valueBlock.valueHexView);
      const certSerial = toHex(cert.serialNumber.valueBlock.valueHexView);
      if (sidSerial !== certSerial) continue;

      // Compare issuers
      const sidIssuerDer = new Uint8Array(sid.issuer.toSchema().toBER(false));
      const certIssuerDer = new Uint8Array(cert.issuer.toSchema().toBER(false));
      if (arraysEqual(sidIssuerDer, certIssuerDer)) {
        return cert;
      }
    }
  }

  // If only one certificate is present, use it as fallback
  if (signedData.certificates.length === 1) {
    const cert = signedData.certificates[0];
    if (cert instanceof pkijs.Certificate) return cert;
  }

  return null;
}

function toHex(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
