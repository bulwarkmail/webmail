// Shared "View source" renderer. Builds a human-readable dump of a message's
// headers, metadata and body from its JMAP Email object. Used both by the
// email viewer's source modal and by the plugin projection so plugins see the
// exact same text the UI shows. Pure: depends only on the passed `email`.

import type { Email } from '@/lib/jmap/types';
import { formatFileSize } from '@/lib/utils';

export function generateEmailSource(email: Email): string {
  let source = '';

  // Headers
  source += '=== EMAIL HEADERS ===\n\n';
  if (email.messageId) source += `Message-ID: ${email.messageId}\n`;
  if (email.from) source += `From: ${email.from.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}\n`;
  if (email.to) source += `To: ${email.to.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}\n`;
  if (email.cc) source += `Cc: ${email.cc.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}\n`;
  if (email.bcc) source += `Bcc: ${email.bcc.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}\n`;
  if (email.replyTo) source += `Reply-To: ${email.replyTo.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}\n`;
  if (email.subject) source += `Subject: ${email.subject}\n`;
  if (email.sentAt) source += `Date: ${new Date(email.sentAt).toUTCString()}\n`;
  if (email.receivedAt) source += `Received-At: ${new Date(email.receivedAt).toUTCString()}\n`;
  if (email.inReplyTo) source += `In-Reply-To: ${email.inReplyTo.join(', ')}\n`;
  if (email.references) source += `References: ${email.references.join(', ')}\n`;

  // Additional headers
  if (email.headers) {
    source += '\n--- Additional Headers ---\n';
    // Headers should now always be a Record after client processing
    Object.entries(email.headers).forEach(([key, value]) => {
      const val = Array.isArray(value) ? value.join('\n    ') : String(value);
      source += `${key}: ${val}\n`;
    });
  }

  // Authentication results
  if (email.authenticationResults) {
    source += '\n--- Authentication Results ---\n';
    if (email.authenticationResults.spf) {
      source += `SPF: ${email.authenticationResults.spf.result}`;
      if (email.authenticationResults.spf.domain) source += ` (${email.authenticationResults.spf.domain})`;
      source += '\n';
    }
    if (email.authenticationResults.dkim) {
      source += `DKIM: ${email.authenticationResults.dkim.result}`;
      if (email.authenticationResults.dkim.domain) source += ` (${email.authenticationResults.dkim.domain})`;
      source += '\n';
    }
    if (email.authenticationResults.dmarc) {
      source += `DMARC: ${email.authenticationResults.dmarc.result}`;
      if (email.authenticationResults.dmarc.policy) source += ` policy=${email.authenticationResults.dmarc.policy}`;
      source += '\n';
    }
  }

  if (email.spamScore !== undefined) {
    source += `Spam Score: ${email.spamScore}`;
    if (email.spamStatus) source += ` (${email.spamStatus})`;
    source += '\n';
  }

  // Metadata
  source += '\n=== EMAIL METADATA ===\n\n';
  source += `Email ID: ${email.id}\n`;
  source += `Thread ID: ${email.threadId}\n`;
  source += `Size: ${formatFileSize(email.size)}\n`;
  source += `Has Attachment: ${email.hasAttachment ? 'Yes' : 'No'}\n`;
  if (email.keywords) {
    const keywords = Object.entries(email.keywords)
      .filter(([_, v]) => v)
      .map(([k]) => k)
      .join(', ');
    if (keywords) source += `Keywords: ${keywords}\n`;
  }

  // Attachments
  if (email.attachments && email.attachments.length > 0) {
    source += '\n=== ATTACHMENTS ===\n\n';
    email.attachments.forEach((att, i) => {
      source += `[${i + 1}] ${att.name || 'Unnamed'}\n`;
      source += `    Type: ${att.type}\n`;
      source += `    Size: ${formatFileSize(att.size)}\n`;
      source += `    Blob ID: ${att.blobId}\n`;
      if (att.cid) source += `    Content-ID: ${att.cid}\n`;
      source += '\n';
    });
  }

  // Body content
  source += '\n=== EMAIL BODY ===\n\n';

  let hasBodyContent = false;

  // Text version
  if (email.textBody?.[0]?.partId && email.bodyValues?.[email.textBody[0].partId]) {
    const textValue = email.bodyValues[email.textBody[0].partId].value;
    if (textValue && textValue.trim()) {
      source += '--- Plain Text Version ---\n\n';
      source += textValue;
      source += '\n\n';
      hasBodyContent = true;
    }
  }

  // HTML version
  if (email.htmlBody?.[0]?.partId && email.bodyValues?.[email.htmlBody[0].partId]) {
    const htmlValue = email.bodyValues[email.htmlBody[0].partId].value;
    if (htmlValue && htmlValue.trim()) {
      source += '--- HTML Version ---\n\n';
      source += htmlValue;
      source += '\n\n';
      hasBodyContent = true;
    }
  }

  // All body values if we haven't found content yet
  if (!hasBodyContent && email.bodyValues) {
    const bodyKeys = Object.keys(email.bodyValues);
    if (bodyKeys.length > 0) {
      source += '--- Body Parts ---\n\n';
      bodyKeys.forEach((key, index) => {
        const bodyValue = email.bodyValues![key].value;
        if (bodyValue && bodyValue.trim()) {
          source += `Part ${index + 1} (${key}):\n`;
          source += bodyValue;
          source += '\n\n';
          hasBodyContent = true;
        }
      });
    }
  }

  // Preview if no body
  if (!hasBodyContent && email.preview) {
    source += '--- Preview Only ---\n\n';
    source += email.preview;
    source += '\n';
  }

  if (!hasBodyContent && !email.preview) {
    source += '(No body content available)\n';
  }

  return source;
}
