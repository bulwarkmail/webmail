import type { VacationResponse } from '@/lib/jmap/types';

/** The reply a VacationResponse holds, without its switch. */
export type StalwartVacationReply = Pick<VacationResponse, 'fromDate' | 'toDate' | 'subject' | 'textBody' | 'htmlBody'>;

/**
 * The "vacation" script Stalwart up to 1.1 writes from VacationResponse/set,
 * always in this one shape (crates/jmap/src/vacation/set.rs, build_script):
 *
 *   require ["vacation", "relational", "date"];
 *
 *   if currentdate :value "ge" "iso8601" "<fromDate>" {    (with a start)
 *   if currentdate :value "le" "iso8601" "<toDate>" {      (with an end)
 *   vacation :mime :subject "<subject>" "<MIME body>";     (:subject when set)
 *   }                                                      (one per block)
 *
 * in CRLF lines, with backslashes and quotes escaped in both strings.
 */
const STALWART_VACATION_RE =
  /^require \["vacation", "relational", "date"\];\r?\n\r?\n(?:if currentdate :value "ge" "iso8601" "([^"]*)" \{\r?\n)?(?:if currentdate :value "le" "iso8601" "([^"]*)" \{\r?\n)?vacation :mime (?::subject "((?:[^"\\]|\\.)*)" )?"((?:[^"\\]|\\.)*)";\r?\n((?:\}\r?\n)*)$/;

/** What Stalwart sends when the reply has no text of its own. */
const STALWART_DEFAULT_TEXT = 'I am away.';

const unescape = (value: string) => value.replace(/\\([\s\S])/g, '$1');

/**
 * The reply in such a script. From Stalwart 1.2 the server keeps the reply
 * in its "managed" script and leaves the old one behind as an ordinary
 * script, so a reply set before the update is only there. Null for a script
 * in any other shape, or one that holds no reply of its own.
 */
export async function parseStalwartVacationScript(content: string): Promise<StalwartVacationReply | null> {
  const match = STALWART_VACATION_RE.exec(content);
  if (!match) return null;
  const [, fromDate, toDate, subject, body, closing] = match;
  const blocks = (fromDate === undefined ? 0 : 1) + (toDate === undefined ? 0 : 1);
  if ((closing.match(/\}/g)?.length ?? 0) !== blocks) return null;

  const { default: PostalMime } = await import('postal-mime');
  const email = await new PostalMime().parse(unescape(body)).catch(() => null);
  if (!email) return null;
  const htmlBody = email.html?.trim() ? email.html : null;
  let textBody = (email.text ?? '').trimEnd();
  if (!htmlBody && textBody === STALWART_DEFAULT_TEXT) textBody = '';

  const reply: StalwartVacationReply = {
    fromDate: fromDate ?? null,
    toDate: toDate ?? null,
    subject: subject === undefined ? '' : unescape(subject),
    textBody,
    htmlBody,
  };
  return reply.subject || reply.textBody || reply.htmlBody || reply.fromDate || reply.toDate ? reply : null;
}
