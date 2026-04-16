/**
 * Detect S/MIME content in an email message.
 *
 * Checks Content-Type headers, bodyStructure, and attachment metadata
 * to determine if a message contains CMS signed or encrypted content.
 */

export type SmimeContentType =
  | 'enveloped-data'   // encrypted
  | 'signed-data'      // opaque signed
  | 'detached-sig'     // multipart/signed (deferred in v1)
  | null;

export interface SmimeDetectionResult {
  /** Primary S/MIME content type detected, or null if none */
  type: SmimeContentType;
  /** The blobId to fetch for CMS processing (enveloped-data or signed-data) */
  blobId?: string;
  /** The partId containing the CMS data */
  partId?: string;
  /** Whether this is a v1-supported type */
  supported: boolean;
}

interface EmailBodyPart {
  partId?: string;
  blobId?: string;
  type?: string;
  name?: string;
  disposition?: string;
  subParts?: EmailBodyPart[];
  headers?: Array<{ name: string; value: string }>;
}

/**
 * Detect S/MIME content from email metadata.
 *
 * @param contentType - The top-level Content-Type header value
 * @param bodyStructure - The JMAP bodyStructure tree
 * @param attachments - Flat list of attachment parts (from `attachments` property)
 */
export function detectSmime(
  contentType?: string,
  bodyStructure?: EmailBodyPart | null,
  attachments?: EmailBodyPart[],
): SmimeDetectionResult {
  const noResult: SmimeDetectionResult = { type: null, supported: false };

  // 1. Check top-level Content-Type header
  if (contentType) {
    const ct = contentType.toLowerCase();

    if (ct.includes('application/pkcs7-mime') || ct.includes('application/x-pkcs7-mime')) {
      if (ct.includes('smime-type=enveloped-data')) {
        const part = findCmsPart(bodyStructure, 'enveloped-data');
        return {
          type: 'enveloped-data',
          blobId: part?.blobId,
          partId: part?.partId,
          supported: true,
        };
      }
      if (ct.includes('smime-type=signed-data')) {
        const part = findCmsPart(bodyStructure, 'signed-data');
        return {
          type: 'signed-data',
          blobId: part?.blobId,
          partId: part?.partId,
          supported: true,
        };
      }
      // Generic pkcs7-mime without explicit smime-type - try bodyStructure
      const part = findCmsPart(bodyStructure, null);
      if (part) {
        const partType = inferSmimeType(part);
        return {
          type: partType,
          blobId: part.blobId,
          partId: part.partId,
          supported: partType === 'enveloped-data' || partType === 'signed-data',
        };
      }
    }

    if (ct.includes('multipart/signed') && ct.includes('application/pkcs7-signature')) {
      return { type: 'detached-sig', supported: false };
    }
  }

  // 2. Walk bodyStructure tree
  if (bodyStructure) {
    const result = walkBodyStructure(bodyStructure);
    if (result) return result;
  }

  // 3. Check attachment list for .p7m files
  if (attachments) {
    for (const att of attachments) {
      const type = att.type?.toLowerCase() || '';
      const name = att.name?.toLowerCase() || '';

      if (type.includes('application/pkcs7-mime') || type.includes('application/x-pkcs7-mime')) {
        const smimeType = inferSmimeTypeFromContentType(type);
        return {
          type: smimeType,
          blobId: att.blobId,
          partId: att.partId,
          supported: smimeType === 'enveloped-data' || smimeType === 'signed-data',
        };
      }

      if (name.endsWith('.p7m')) {
        return {
          type: 'enveloped-data', // .p7m is ambiguous but commonly encrypted
          blobId: att.blobId,
          partId: att.partId,
          supported: true,
        };
      }

      if (name.endsWith('.p7s')) {
        return { type: 'detached-sig', blobId: att.blobId, partId: att.partId, supported: false };
      }
    }
  }

  return noResult;
}

function walkBodyStructure(part: EmailBodyPart): SmimeDetectionResult | null {
  const type = part.type?.toLowerCase() || '';

  if (type.includes('application/pkcs7-mime') || type.includes('application/x-pkcs7-mime')) {
    const smimeType = inferSmimeTypeFromContentType(type);
    return {
      type: smimeType,
      blobId: part.blobId,
      partId: part.partId,
      supported: smimeType === 'enveloped-data' || smimeType === 'signed-data',
    };
  }

  if (type === 'multipart/signed') {
    // Check for pkcs7-signature protocol in subparts
    if (part.subParts?.some(sp => sp.type?.toLowerCase().includes('application/pkcs7-signature'))) {
      return { type: 'detached-sig', supported: false };
    }
  }

  if (part.subParts) {
    for (const sub of part.subParts) {
      const result = walkBodyStructure(sub);
      if (result) return result;
    }
  }

  return null;
}

function findCmsPart(bodyStructure: EmailBodyPart | null | undefined, smimeType: string | null): EmailBodyPart | null {
  if (!bodyStructure) return null;

  const type = bodyStructure.type?.toLowerCase() || '';
  if (type.includes('application/pkcs7-mime') || type.includes('application/x-pkcs7-mime')) {
    // JMAP bodyStructure.type may not include smime-type parameter,
    // so accept any pkcs7-mime part when the smime-type was already
    // determined from the Content-Type header.
    return bodyStructure;
  }

  if (bodyStructure.subParts) {
    for (const sub of bodyStructure.subParts) {
      const found = findCmsPart(sub, smimeType);
      if (found) return found;
    }
  }

  return null;
}

function inferSmimeType(part: EmailBodyPart): SmimeContentType {
  return inferSmimeTypeFromContentType(part.type || '');
}

function inferSmimeTypeFromContentType(ct: string): SmimeContentType {
  const lower = ct.toLowerCase();
  if (lower.includes('smime-type=enveloped-data')) return 'enveloped-data';
  if (lower.includes('smime-type=signed-data')) return 'signed-data';
  // Default for generic pkcs7-mime: assume enveloped-data (most common)
  if (lower.includes('application/pkcs7-mime') || lower.includes('application/x-pkcs7-mime')) {
    return 'enveloped-data';
  }
  return null;
}
