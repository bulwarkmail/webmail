/**
 * FakeJmapMail with what drafts talk to: Email/set create, uploads and blob
 * downloads. Follows Stalwart: a part names a blob it knows or the create is
 * refused with `blobNotFound`, two creates with one Message-ID are both accepted,
 * and each create makes a new message.
 */

import { TransportError, type JmapResponse, type MethodCall } from '../../engine/transport';
import { type FakeEmail } from './fake-jmap';
import { FakeJmapMail } from './fake-jmap-mail';

interface Part {
  partId?: string;
  blobId?: string;
  type?: string;
  name?: string;
  disposition?: string;
  cid?: string;
  subParts?: Part[];
}

export class FakeJmapDrafts extends FakeJmapMail {
  /** What was uploaded or attached, by blob id. */
  readonly blobs = new Map<string, Uint8Array>();
  readonly uploads: Array<{ blobId: string; size: number }> = [];
  /** The order things happened in, for tests about order. */
  readonly log: string[] = [];
  /** Every create is refused with this. */
  refuseCreate: { type: string; description?: string } | null = null;
  /** The server does the work of the next request naming this method, and the answer never arrives. */
  loseAnswerOf: string | null = null;
  /** The next upload fails like a dropped connection. */
  failUpload = false;
  now = Date.UTC(2026, 10, 3);
  private nextCreated = 1;
  private nextBlob = 1;

  drafts(): FakeEmail[] {
    return [...this.emails.values()].filter((email) => (email.mailboxIds as Record<string, boolean>).drafts);
  }

  private knows(blobId: string): boolean {
    if (this.blobs.has(blobId)) return true;
    return [...this.emails.values()].some((email) => (email.attachments as Part[] | undefined)?.some((part) => part.blobId === blobId));
  }

  private partsOf(create: Record<string, unknown>): Part[] {
    const leaves = (part: Part): Part[] => (part.subParts ? part.subParts.flatMap(leaves) : [part]);
    return [...((create.attachments ?? []) as Part[]), ...(create.bodyStructure ? leaves(create.bodyStructure as Part) : [])].filter((part) => part.blobId);
  }

  private createOne(create: Record<string, unknown>): { id: string; blobId: string; threadId: string; size: number } | { type: string; description?: string } {
    if (this.refuseCreate) return this.refuseCreate;
    const parts = this.partsOf(create);
    if (parts.some((part) => !this.knows(part.blobId as string))) return { type: 'blobNotFound' };
    const id = `srv${this.nextCreated++}`;
    const values = (create.bodyValues ?? {}) as Record<string, { value: string }>;
    const size = Object.values(values).reduce((sum, value) => sum + value.value.length, 0);
    this.addEmail({
      id,
      threadId: `t-${id}`,
      mailboxIds: create.mailboxIds as Record<string, boolean>,
      keywords: create.keywords as Record<string, boolean>,
      subject: String(create.subject ?? ''),
      from: create.from as never,
      to: create.to as never,
      messageId: create.messageId as never,
      receivedAt: new Date(this.now).toISOString(),
      size,
      blobId: `raw-${id}`,
      preview: '',
      hasAttachment: parts.length > 0,
      textBody: (create.textBody ?? []) as never,
      htmlBody: (create.htmlBody ?? create.textBody ?? []) as never,
      bodyValues: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value: value.value, isTruncated: false, isEncodingProblem: false }])) as never,
      attachments: parts.map((part) => ({ ...part, size: this.blobs.get(part.blobId as string)?.length ?? 0 })) as never,
    });
    this.log.push(`create ${id}`);
    return { id, blobId: `raw-${id}`, threadId: `t-${id}`, size };
  }

  protected override handle(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (name !== 'Email/set') return super.handle(name, args);
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    for (const [creationId, create] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
      const answer = this.createOne(create);
      if ('id' in answer) created[creationId] = answer;
      else notCreated[creationId] = answer;
    }
    for (const id of (args.destroy ?? []) as string[]) this.log.push(`destroy ${id}`);
    return {
      ...super.handle(name, args),
      ...(args.create ? { created } : {}),
      ...(Object.keys(notCreated).length > 0 ? { notCreated } : {}),
    };
  }

  override async request(calls: MethodCall[]): Promise<JmapResponse> {
    const answer = await super.request(calls);
    if (this.loseAnswerOf && calls.some(([name]) => name === this.loseAnswerOf)) {
      this.loseAnswerOf = null;
      throw new TransportError('network', 'The connection broke');
    }
    return answer;
  }

  override async upload(_jmap?: string, data?: Uint8Array): Promise<{ blobId: string; type: string; size: number }> {
    if (this.offline || this.failUpload) {
      this.failUpload = false;
      throw new TransportError('network', 'Failed to fetch');
    }
    const blobId = `up${this.nextBlob++}`;
    const bytes = data ?? new Uint8Array();
    this.blobs.set(blobId, bytes);
    this.uploads.push({ blobId, size: bytes.length });
    this.log.push(`upload ${blobId}`);
    return { blobId, type: 'application/octet-stream', size: bytes.length };
  }
}
