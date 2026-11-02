// Area b of the assistant's host APIs, inside the plugin sandbox (see README.md).

import type { CallApi, RuntimeAdditions } from './runtime';
import type { EmailReadView } from '../../plugin-types';
import type { AttachmentImageOptions, AttachmentImageView, AttachmentTextOptions, AttachmentTextView } from './b.types';
import { NETWORK_API_TIMEOUT_MS } from '../api-timeouts';

/** The methods this area adds to the plugin's api, by namespace. */
export function runtime(callApi: CallApi): RuntimeAdditions {
  return {
    email: {
      /**
       * The text of one attachment of a message (email:blob-read, 30 a
       * minute): PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV,
       * HTML, calendar and address files. See AttachmentTextView.status.
       */
      getAttachmentText: (emailId: string, blobId: string, options?: AttachmentTextOptions) =>
        callApi('email.getAttachmentText', [emailId, blobId, options], NETWORK_API_TIMEOUT_MS) as Promise<AttachmentTextView>,
      /**
       * An image attachment or inline image of a message, shrunk to maxSide
       * (default 1568 px) and at most 1.5 MB, as base64 (email:blob-read, 30
       * a minute). Tracking pixels and tiny images answer a status instead.
       * The photo's date and place only with exif: true.
       */
      getAttachmentImage: (emailId: string, blobId: string, options?: AttachmentImageOptions) =>
        callApi('email.getAttachmentImage', [emailId, blobId, options], NETWORK_API_TIMEOUT_MS) as Promise<AttachmentImageView>,
      /**
       * Every message of the conversation a message belongs to, oldest
       * first, at most the newest 50 (email:read, 60 a minute).
       */
      getThread: (emailId: string, options?: { accountId?: string }) =>
        callApi('email.getThread', [emailId, options], NETWORK_API_TIMEOUT_MS) as Promise<EmailReadView[]>,
    },
  };
}
