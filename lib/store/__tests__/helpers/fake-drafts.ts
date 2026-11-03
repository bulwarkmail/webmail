/**
 * FakeJmapMail with what drafts talk to: Email/set create, uploads, blob
 * downloads and a send. Follows Stalwart: every new message gets new part ids,
 * and a part's id dies with its message, so a create naming one gets
 * `blobNotFound`. An upload's id stays usable. Two creates with one Message-ID
 * are both accepted, and each create makes a new message.
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
  size?: number;
  subParts?: Part[];
}

export class FakeJmapDrafts extends FakeJmapMail {
  /** What was uploaded, by blob id. */
  readonly blobs = new Map<string, Uint8Array>();
  /** The bytes of the parts of messages, by part id. */
  readonly parts = new Map<string, Uint8Array>();
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
  private nextPart = 1;
  private createdInRequest = new Map<string, string>();
  private readonly destroyedSubmissions: string[] = [];

  drafts(): FakeEmail[] {
    return [...this.emails.values()].filter((email) => (email.mailboxIds as Record<string, boolean>).drafts);
  }

  submissionsDestroyed(): readonly string[] {
    return this.destroyedSubmissions;
  }

  private knows(blobId: string): boolean {
    if (this.blobs.has(blobId)) return true;
    return [...this.emails.values()].some((email) => (email.attachments as Part[] | undefined)?.some((part) => part.blobId === blobId));
  }

  /** The bytes behind an upload or a part still alive. */
  bytesOf(blobId: string): Uint8Array | undefined {
    return this.blobs.get(blobId) ?? (this.knows(blobId) ? this.parts.get(blobId) : undefined);
  }

  private partsOf(create: Record<string, unknown>): Part[] {
    const leaves = (part: Part): Part[] => (part.subParts ? part.subParts.flatMap(leaves) : [part]);
    return [...((create.attachments ?? []) as Part[]), ...(create.bodyStructure ? leaves(create.bodyStructure as Part) : [])].filter((part) => part.blobId);
  }

  private createOne(create: Record<string, unknown>): { id: string; blobId: string; threadId: string; size: number } | { type: string; description?: string } {
    if (this.refuseCreate) return this.refuseCreate;
    const named = this.partsOf(create);
    if (named.some((part) => !this.knows(part.blobId as string))) return { type: 'blobNotFound' };
    const id = `srv${this.nextCreated++}`;
    const values = (create.bodyValues ?? {}) as Record<string, { value: string }>;
    const attachments = named.map((part) => {
      const data = this.bytesOf(part.blobId as string) ?? new Uint8Array();
      const fresh = `part${this.nextPart++}`;
      this.parts.set(fresh, data);
      return { ...part, partId: fresh, blobId: fresh, size: data.length };
    });
    const size = Object.values(values).reduce((sum, value) => sum + value.value.length, 0) + attachments.reduce((sum, part) => sum + part.size, 0);
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
      hasAttachment: named.length > 0,
      textBody: (create.textBody ?? []) as never,
      htmlBody: (create.htmlBody ?? create.textBody ?? []) as never,
      bodyValues: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value: value.value, isTruncated: false, isEncodingProblem: false }])) as never,
      attachments: attachments as never,
    });
    this.log.push(`create ${id}`);
    return { id, blobId: `raw-${id}`, threadId: `t-${id}`, size };
  }

  private submissionSet(args: Record<string, unknown>): Record<string, unknown> {
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    for (const [key, create] of Object.entries((args.create ?? {}) as Record<string, { emailId: string }>)) {
      const emailId = create.emailId.startsWith('#') ? this.createdInRequest.get(create.emailId.slice(1)) : create.emailId;
      if (!emailId || !this.emails.has(emailId)) {
        notCreated[key] = { type: 'invalidProperties' };
        continue;
      }
      created[key] = { id: this.addSubmission(emailId, 'final').id, undoStatus: 'final' };
      this.log.push(`submit ${emailId}`);
      const email = this.emails.get(emailId) as FakeEmail;
      const keywords = { ...(email.keywords as Record<string, boolean>) };
      delete keywords.$draft;
      this.updateEmail(emailId, { keywords, mailboxIds: { sent: true } });
    }
    const destroyed = (args.destroy ?? []) as string[];
    for (const id of destroyed) {
      this.submissions.delete(id);
      this.destroyedSubmissions.push(id);
    }
    return {
      accountId: args.accountId,
      ...(args.create ? { created } : {}),
      ...(Object.keys(notCreated).length > 0 ? { notCreated } : {}),
      ...(args.destroy ? { destroyed } : {}),
    };
  }

  protected override handle(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (name === 'EmailSubmission/set') return this.submissionSet(args);
    if (name !== 'Email/set') return super.handle(name, args);
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    for (const [creationId, create] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
      const answer = this.createOne(create);
      if ('id' in answer) {
        created[creationId] = answer;
        this.createdInRequest.set(creationId, answer.id);
      } else {
        notCreated[creationId] = answer;
      }
    }
    for (const id of (args.destroy ?? []) as string[]) this.log.push(`destroy ${id}`);
    return {
      ...super.handle(name, args),
      ...(args.create ? { created } : {}),
      ...(Object.keys(notCreated).length > 0 ? { notCreated } : {}),
    };
  }

  override async request(calls: MethodCall[]): Promise<JmapResponse> {
    this.createdInRequest = new Map();
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
