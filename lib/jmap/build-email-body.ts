/**
 * Build JMAP Email/set body fields with standards-correct MIME nesting for
 * CID inline images (multipart/related under multipart/alternative).
 *
 * When no inline CID parts are present, falls back to the flat textBody /
 * htmlBody / attachments representation Bulwark used previously.
 */

export type EmailAttachmentInput = {
  blobId: string;
  name: string;
  type: string;
  size: number;
  disposition?: 'attachment' | 'inline';
  cid?: string;
};

type BodyPartRef = { partId: string; type?: string };

type FlatAttachment = {
  blobId: string;
  type: string;
  name: string;
  disposition: string;
  cid?: string;
};

type BodyStructurePart = Record<string, unknown>;

export type EmailBodyBuildResult = {
  bodyValues: Record<string, { value: string }>;
  bodyStructure?: BodyStructurePart;
  textBody?: BodyPartRef[];
  htmlBody?: BodyPartRef[];
  attachments?: FlatAttachment[];
};

function isInlineCidAttachment(att: EmailAttachmentInput, hasHtml: boolean): boolean {
  if (!hasHtml || !att.cid) return false;
  if (att.disposition === 'attachment') return false;
  return att.disposition === 'inline' || att.disposition === undefined;
}

function mapFlatAttachment(att: EmailAttachmentInput): FlatAttachment {
  return {
    blobId: att.blobId,
    type: att.type,
    name: att.name,
    disposition: att.disposition ?? 'attachment',
    ...(att.cid ? { cid: att.cid } : {}),
  };
}

function mapBlobBodyPart(att: EmailAttachmentInput, disposition: string): BodyStructurePart {
  return {
    blobId: att.blobId,
    type: att.type,
    name: att.name,
    disposition,
    ...(att.cid ? { cid: att.cid } : {}),
    ...(att.size > 0 ? { size: att.size } : {}),
  };
}

function buildAlternativeWithRelated(
  inlineAttachments: EmailAttachmentInput[],
): BodyStructurePart {
  return {
    type: 'multipart/alternative',
    subParts: [
      { partId: 'text', type: 'text/plain' },
      {
        type: 'multipart/related',
        subParts: [
          { partId: 'html', type: 'text/html' },
          ...inlineAttachments.map((att) => mapBlobBodyPart(att, 'inline')),
        ],
      },
    ],
  };
}

export function buildEmailBodyForSet(input: {
  textBody: string;
  htmlBody?: string;
  attachments?: EmailAttachmentInput[];
}): EmailBodyBuildResult {
  const { textBody, htmlBody, attachments = [] } = input;
  const hasHtml = Boolean(htmlBody);

  const inlineAttachments = attachments.filter((att) => isInlineCidAttachment(att, hasHtml));
  const regularAttachments = attachments.filter((att) => !isInlineCidAttachment(att, hasHtml));

  if (!hasHtml || inlineAttachments.length === 0) {
    if (htmlBody) {
      return {
        bodyValues: {
          text: { value: textBody },
          html: { value: htmlBody },
        },
        textBody: [{ partId: 'text', type: 'text/plain' }],
        htmlBody: [{ partId: 'html', type: 'text/html' }],
        ...(attachments.length
          ? { attachments: attachments.map(mapFlatAttachment) }
          : {}),
      };
    }

    return {
      bodyValues: { '1': { value: textBody } },
      textBody: [{ partId: '1' }],
      ...(attachments.length
        ? { attachments: attachments.map(mapFlatAttachment) }
        : {}),
    };
  }

  const alternativeTree = buildAlternativeWithRelated(inlineAttachments);
  const bodyStructure: BodyStructurePart = regularAttachments.length
    ? {
        type: 'multipart/mixed',
        subParts: [
          alternativeTree,
          ...regularAttachments.map((att) => mapBlobBodyPart(att, att.disposition ?? 'attachment')),
        ],
      }
    : alternativeTree;

  return {
    bodyStructure,
    bodyValues: {
      text: { value: textBody },
      html: { value: htmlBody! },
    },
  };
}

export function applyEmailBodyToCreate(
  target: Record<string, unknown>,
  built: EmailBodyBuildResult,
): void {
  target.bodyValues = built.bodyValues;
  if (built.bodyStructure) {
    target.bodyStructure = built.bodyStructure;
    return;
  }
  target.textBody = built.textBody;
  if (built.htmlBody) target.htmlBody = built.htmlBody;
  if (built.attachments?.length) target.attachments = built.attachments;
}
