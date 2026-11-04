/**
 * A listing across JMAP accounts where at least one account couldn't answer.
 * It carries what the others gave. An account that failed isn't an account
 * with nothing in it, so the caller keeps what it had for that one.
 */
export class PartialAccountsError<T> extends Error {
  constructor(
    readonly items: T[],
    readonly failedAccountIds: string[],
    readonly primaryAccountId: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'An account could not answer');
    this.name = 'PartialAccountsError';
  }
}

/** By name: `instanceof` fails across Next's bundle copies. */
export function partialAccounts<T>(error: unknown): PartialAccountsError<T> | null {
  return error instanceof Error && error.name === 'PartialAccountsError' ? error as PartialAccountsError<T> : null;
}

/** What to show after a partial listing: the answers, and what's held for the accounts that failed. */
export function withFailedAccountsKept<T extends { accountId?: string }>(partial: PartialAccountsError<T>, held: readonly T[]): T[] {
  const failed = new Set(partial.failedAccountIds);
  return [...partial.items, ...held.filter((item) => failed.has(item.accountId ?? partial.primaryAccountId))];
}
