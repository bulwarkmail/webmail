import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareQuickReply, type QuickReplyQuestion, type QuickReplyQuestions } from '@/lib/outgoing/quick-reply';
import { registerOutgoingFinalizer, registerPreSendCheck, resetSendPipeline } from '@/lib/outgoing/send-pipeline';
import type { Identity } from '@/lib/jmap/types';
import { emailHooks, pluginErrorTracker } from '@/lib/plugin-hooks';
import type { OutgoingEmail } from '@/lib/plugin-types';

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));

// Quick reply goes through the same checks and finalisers as the composer,
// so the disclaimer and the external-recipient confirm reach it too.

const html = { id: 'i', name: 'Me', email: 'me@example.com', htmlSignature: '<b>Me</b>', textSignature: '' } as Identity;
const text = { id: 'i', name: 'Me', email: 'me@example.com', htmlSignature: '', textSignature: 'Me' } as Identity;
const input = (signatureIdentity: Identity) => ({
  body: 'Thanks <3', signatureIdentity, separator: true, to: ['bob@example.com'], fromEmail: 'me@example.com', identityId: 'i',
});

afterEach(() => {
  resetSendPipeline();
  emailHooks.onBeforeEmailSend.clear();
  pluginErrorTracker.resetAll();
});

describe('prepareQuickReply', () => {
  it('builds the text and, for an HTML signature, an escaped HTML body', async () => {
    const withHtml = await prepareQuickReply(input(html));
    expect(withHtml?.html).toContain('<div>Thanks &lt;3</div>');
    expect(withHtml?.html).toContain('<b>Me</b>');
    expect(withHtml?.text).toContain('Thanks <3');
    const plain = await prepareQuickReply(input(text));
    expect(plain?.html).toBeUndefined();
    expect(plain?.text).toMatch(/Thanks <3[\s\S]*-- \nMe$/);
  });

  it('sends the bare text when the reply signature toggle is off', async () => {
    const withHtml = await prepareQuickReply({ ...input(html), insertSignature: false });
    expect(withHtml?.html).toBeUndefined();
    expect(withHtml?.text).toBe('Thanks <3');
    const plain = await prepareQuickReply({ ...input(text), insertSignature: false });
    expect(plain?.text).toBe('Thanks <3');
  });

  it('runs the finalisers with a reply context', async () => {
    const contexts: unknown[] = [];
    registerOutgoingFinalizer('f', 10, (bodies, context) => {
      contexts.push(context);
      return { html: bodies.html, text: `${bodies.text}\nFooter` };
    });
    const out = await prepareQuickReply(input(text));
    expect(out?.text).toMatch(/\nFooter$/);
    expect(contexts).toEqual([expect.objectContaining({ surface: 'quick-reply', mode: 'reply', to: ['bob@example.com'], plainText: true })]);
  });

  it('sends nothing when a check says no', async () => {
    registerPreSendCheck('no', 10, () => false);
    expect(await prepareQuickReply(input(text))).toBeNull();
  });
});

// The composer warns about placeholders and forgotten attachments and asks
// "Send this message?" when that is on. Quick reply went out without any of
// them, an admin-enforced send confirmation included.
describe('prepareQuickReply warnings', () => {
  const words = [{ before: ['your'], after: [], unfinished: ['TODO'] }];
  const questions = (answer: boolean, overrides: Partial<QuickReplyQuestions> = {}) => {
    const asked: QuickReplyQuestion[] = [];
    return {
      asked,
      questions: {
        placeholderWords: words,
        attachmentKeywords: ['attached', 'anbei'],
        confirmSend: false,
        ask: async (q: QuickReplyQuestion) => { asked.push(q); return answer; },
        ...overrides,
      } satisfies QuickReplyQuestions,
    };
  };
  const reply = (body: string, q: QuickReplyQuestions) => prepareQuickReply({ ...input(text), body, questions: q });

  it('asks about unfilled placeholders and stops on "back"', async () => {
    const { asked, questions: q } = questions(false);
    expect(await reply('See you at [TIME]. TODO', q)).toBeNull();
    expect(asked).toEqual([{ kind: 'placeholders', found: ['[TIME]', 'TODO'] }]);
  });

  it('asks about a forgotten attachment and stops on "back"', async () => {
    const { asked, questions: q } = questions(false);
    expect(await reply('Die Datei ist anbei.', q)).toBeNull();
    expect(asked).toEqual([{ kind: 'attachment', keyword: 'anbei' }]);
  });

  it('asks before sending when send confirmation is on, after the pre-send checks', async () => {
    const order: string[] = [];
    registerPreSendCheck('external', 10, () => { order.push('check'); return true; });
    const { questions: q } = questions(false, { confirmSend: true });
    const ask = async (question: QuickReplyQuestion) => { order.push(question.kind); return false; };
    expect(await reply('Thanks!', { ...q, ask })).toBeNull();
    expect(order).toEqual(['check', 'send']);
  });

  it('sends when every question is answered with "send anyway"', async () => {
    const { asked, questions: q } = questions(true, { confirmSend: true });
    const out = await reply('[TIME] works, file attached', q);
    expect(out?.text).toContain('[TIME] works, file attached');
    expect(asked.map((a) => a.kind)).toEqual(['placeholders', 'attachment', 'send']);
  });

  it('asks nothing for a plain reply, or when the warnings are off', async () => {
    const { asked, questions: q } = questions(false);
    expect(await reply('Thanks, see you then.', q)).not.toBeNull();
    const off = questions(false, { placeholderWords: null, attachmentKeywords: null });
    expect(await reply('[TIME], attached', off.questions)).not.toBeNull();
    expect([...asked, ...off.asked]).toEqual([]);
  });

  it('leaves the signature out of the placeholder check', async () => {
    const signed = { ...text, textSignature: 'Me\n[YOUR TITLE]' } as Identity;
    const { asked, questions: q } = questions(false);
    expect(await prepareQuickReply({ ...input(signed), body: 'Thanks!', questions: q })).not.toBeNull();
    expect(asked).toEqual([]);
  });
});

// Plugins' send checks (onBeforeEmailSend) ran for the composer and a
// plugin's forward, never for a quick reply: a way around a send guard.
describe('prepareQuickReply and plugin send checks', () => {
  it('asks the plugins with the reply and stops when one says no', async () => {
    const seen: OutgoingEmail[] = [];
    emailHooks.onBeforeEmailSend.register('guard', (email: OutgoingEmail) => { seen.push(email); return false; });
    const stopped: string[] = [];
    const out = await prepareQuickReply({
      ...input(text), body: 'IBAN DE89370400440532013000', subject: 'Re: Invoice', inReplyTo: '<m1@example.com>',
      onSendCheckStopped: (outcome) => stopped.push(outcome),
    });
    expect(out).toBeNull();
    expect(stopped).toEqual(['vetoed']);
    expect(seen).toEqual([expect.objectContaining({
      surface: 'quick-reply', mode: 'reply', to: ['bob@example.com'], subject: 'Re: Invoice',
      inReplyTo: '<m1@example.com>', identityId: 'i', fromEmail: 'me@example.com',
    })]);
    expect(seen[0].textBody).toContain('IBAN DE89370400440532013000');
  });

  it('hands over the typed text and the recipients outside the organisation', async () => {
    const seen: OutgoingEmail[] = [];
    emailHooks.onBeforeEmailSend.register('guard', (email: OutgoingEmail) => { seen.push(email); return undefined; });
    expect(await prepareQuickReply({ ...input(text), body: 'Card 4242 4242 4242 4242', to: ['bob@example.com', 'Eve@Other.test'] })).not.toBeNull();
    expect(seen[0].authoredText).toBe('Card 4242 4242 4242 4242');
    expect(seen[0].externalRecipients).toEqual(['eve@other.test']);
  });

  it('fails closed when a check crashes', async () => {
    emailHooks.onBeforeEmailSend.register('guard', () => { throw new Error('boom'); });
    const stopped: string[] = [];
    expect(await prepareQuickReply({ ...input(text), onSendCheckStopped: (o) => stopped.push(o) })).toBeNull();
    expect(stopped).toEqual(['failed']);
  });

  it('sends when the plugins allow it, with the disclaimer stage after them', async () => {
    const order: string[] = [];
    emailHooks.onBeforeEmailSend.register('guard', () => { order.push('plugin'); return undefined; });
    registerOutgoingFinalizer('disclaimer', 10, (bodies) => { order.push('last'); return bodies; }, 'last');
    expect(await prepareQuickReply(input(text))).not.toBeNull();
    expect(order).toEqual(['plugin', 'last']);
  });
});
