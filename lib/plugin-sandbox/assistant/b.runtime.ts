// Area b of the assistant's host APIs, inside the plugin sandbox (see README.md).

import type { CallApi, RuntimeAdditions } from './runtime';
import type { AttachmentTextOptions, AttachmentTextView } from './b.types';

/** Reads that download and unpack a file get the network timeout. */
const READ_TIMEOUT_MS = 120_000;

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
        callApi('email.getAttachmentText', [emailId, blobId, options], READ_TIMEOUT_MS) as Promise<AttachmentTextView>,
    },
  };
}
