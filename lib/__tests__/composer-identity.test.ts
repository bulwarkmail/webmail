import { describe, expect, it } from 'vitest';
import type { Identity } from '@/lib/jmap/types';
import { resolveComposerFrom } from '../composer-identity';

// What the composer's From stands for. Identity ids repeat across logins
// (`b` is the first identity everywhere), so an identity of another login
// that is no longer listed must not turn into one of this login.

const identity = (id: string, email: string): Identity => ({ id, email, name: email.split('@')[0] }) as Identity;
const HOME = identity('b', 'me@home.example');
const HOME_ALIAS = identity('c', 'alias@home.example');
const WORK = identity('login-work::b', 'me@work.example');

describe('resolveComposerFrom', () => {
  it('is the primary identity while none is chosen', () => {
    expect(resolveComposerFrom(null, [HOME, HOME_ALIAS], HOME, 'login-home', null)).toEqual({ identity: HOME, unlisted: false });
  });

  it('is the chosen identity while it is listed', () => {
    expect(resolveComposerFrom('c', [HOME, HOME_ALIAS], HOME, 'login-home', null)).toEqual({ identity: HOME_ALIAS, unlisted: false });
    expect(resolveComposerFrom(WORK.id, [identity('login-home::b', HOME.email), WORK], HOME, 'login-home', null))
      .toEqual({ identity: WORK, unlisted: false });
  });

  it('stays the other login\'s identity once that login left the list, as it was last listed', () => {
    // Only the home login is left: its identities, without login names.
    const from = resolveComposerFrom(WORK.id, [HOME, HOME_ALIAS], HOME, 'login-home', WORK);
    expect(from).toEqual({ identity: WORK, unlisted: true });
  });

  it('never becomes this login\'s identity with the same raw id', () => {
    // WORK's raw id is `b`, and so is HOME's.
    const from = resolveComposerFrom(WORK.id, [HOME, HOME_ALIAS], HOME, 'login-home', null);
    expect(from.unlisted).toBe(true);
    expect(from.identity?.id).toBe(WORK.id);
    expect(from.identity?.email).toBe('');
  });

  it('does not take an identity that was listed under another id for the chosen one', () => {
    const from = resolveComposerFrom(WORK.id, [HOME], HOME, 'login-home', identity('login-other::b', 'me@other.example'));
    expect(from.identity?.id).toBe(WORK.id);
    expect(from.identity?.email).toBe('');
  });

  it('finds an identity of the composer\'s own login under its bare id once the list names no logins', () => {
    // Chosen while two logins were connected; one is left.
    expect(resolveComposerFrom('login-home::c', [HOME, HOME_ALIAS], HOME, 'login-home', null))
      .toEqual({ identity: HOME_ALIAS, unlisted: false });
  });

  it('finds an identity chosen by its bare id once the list names logins', () => {
    // Chosen with one login connected; a second one signed in since.
    const listed = [identity('login-home::b', HOME.email), identity('login-home::c', HOME_ALIAS.email), WORK];
    expect(resolveComposerFrom('c', listed, HOME, 'login-home', null)).toEqual({ identity: listed[1], unlisted: false });
  });

  it('falls back to the primary identity for one of the composer\'s own login that no longer exists', () => {
    expect(resolveComposerFrom('gone', [HOME, HOME_ALIAS], HOME, 'login-home', null)).toEqual({ identity: HOME, unlisted: false });
    expect(resolveComposerFrom('login-home::gone', [HOME, HOME_ALIAS], HOME, 'login-home', null)).toEqual({ identity: HOME, unlisted: false });
  });
});
