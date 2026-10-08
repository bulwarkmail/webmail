/** Archive failed after some messages may already have been confirmed updated. */
export class ArchiveEmailsError extends Error {
  constructor(message: string, readonly updatedIds: string[], options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArchiveEmailsError';
  }
}
