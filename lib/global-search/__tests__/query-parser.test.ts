import { describe, expect, it } from 'vitest';
import { splitSearchText } from '@/lib/jmap/search-utils';
import { accountMatches, matchesTerms, parseSearchQuery, tokenizeQuery, withScopeAndAccount } from '../query-parser';

describe('parseSearchQuery', () => {
  it('treats plain words as free text terms', () => {
    const parsed = parseSearchQuery('  quarterly Report ');
    expect(parsed.text).toBe('quarterly Report');
    expect(parsed.terms).toEqual(['quarterly', 'report']);
    expect(parsed.scope).toBe('all');
    expect(parsed.hasOperators).toBe(false);
  });

  it('keeps quoted phrases intact for the server and lower-cases them for local matching', () => {
    const parsed = parseSearchQuery('"Q3 planning" budget');
    expect(parsed.text).toBe('"Q3 planning" budget');
    expect(parsed.terms).toEqual(['q3 planning', 'budget']);
    // The search paths split the text again, one condition per phrase.
    expect(splitSearchText(parsed.text)).toEqual(['"Q3 planning"', 'budget']);
  });

  it('produces text that splits into the same parts as the typed query', () => {
    const typed = [
      '"annual report" 2024 "draft"',
      'project budg*',
      '"half typed',
      '"a b" c d*',
      "'annual' 2024 'draft'",
      '"" * budget',
      're: meeting 10:30',
    ];
    for (const raw of typed) {
      expect(splitSearchText(parseSearchQuery(raw).text)).toEqual(splitSearchText(raw));
    }
    const withOperators = parseSearchQuery('from:anna "annual report" in:mail 2024 after:2026-01-01 "draft"');
    expect(splitSearchText(withOperators.text)).toEqual(['"annual report"', '2024', '"draft"']);
  });

  it('tolerates an unterminated quote while the user is still typing', () => {
    expect(parseSearchQuery('"half typed').terms).toEqual(['half typed']);
  });

  it('parses in: with aliases, including trash/junk as mail-only roles', () => {
    expect(parseSearchQuery('in:contacts bob').scope).toBe('contacts');
    expect(parseSearchQuery('in:events bob').scope).toBe('calendar');
    expect(parseSearchQuery('in:drive bob').scope).toBe('files');
    const trash = parseSearchQuery('in:trash invoice');
    expect(trash.scope).toBe('mail');
    expect(trash.mailboxRole).toBe('trash');
    expect(parseSearchQuery('in:spam x').mailboxRole).toBe('junk');
  });

  it('maps mail operators onto SearchFilters', () => {
    const parsed = parseSearchQuery('from:alice to:bob subject:"Q3 report" has:attachment is:unread is:starred invoice');
    expect(parsed.mail.from).toBe('alice');
    expect(parsed.mail.to).toBe('bob');
    expect(parsed.mail.subject).toBe('Q3 report');
    expect(parsed.mail.hasAttachment).toBe(true);
    expect(parsed.mail.isUnread).toBe(true);
    expect(parsed.mail.isStarred).toBe(true);
    expect(parsed.text).toBe('invoice');
    expect(parsed.hasOperators).toBe(true);
  });

  it('accepts valid dates and feeds them to both mail and calendar', () => {
    const parsed = parseSearchQuery('after:2026-01-01 before:2026-02-28 sync');
    expect(parsed.after).toBe('2026-01-01');
    expect(parsed.before).toBe('2026-02-28');
    expect(parsed.mail.dateAfter).toBe('2026-01-01');
    expect(parsed.mail.dateBefore).toBe('2026-02-28');
  });

  it('keeps malformed dates and unknown operators as free text', () => {
    const parsed = parseSearchQuery('after:2026-02-31 size:>5MB before:yesterday tag:x hello');
    expect(parsed.after).toBeNull();
    expect(parsed.before).toBeNull();
    expect(parsed.terms).toEqual(['after:2026-02-31', 'size:>5mb', 'before:yesterday', 'tag:x', 'hello']);
    expect(parsed.hasOperators).toBe(false);
  });

  it('is:untagged and has:notag ask for mail without a tag', () => {
    for (const query of ['is:untagged x', 'has:notag x', 'has:notags x', 'IS:Untagged x']) {
      const parsed = parseSearchQuery(query);
      expect(parsed.mail.untagged).toBe(true);
      expect(parsed.text).toBe('x');
      expect(parsed.hasOperators).toBe(true);
    }
    expect(parseSearchQuery('x').mail.untagged).toBe(false);
  });

  it('is:anything lifts the trash/junk exclusion', () => {
    expect(parseSearchQuery('is:anything x').includeTrashAndJunk).toBe(true);
    expect(parseSearchQuery('x').includeTrashAndJunk).toBe(false);
  });

  it('lower-cases the account operator and supports quoted labels', () => {
    expect(parseSearchQuery('account:Work x').account).toBe('work');
    expect(parseSearchQuery('account:"Linus Rath" x').account).toBe('linus rath');
  });

  it('handles a colon inside an ordinary word', () => {
    const parsed = parseSearchQuery('re: meeting 10:30');
    expect(parsed.terms).toEqual(['re:', 'meeting', '10:30']);
  });
});

describe('tokenizeQuery', () => {
  it('splits operators, quoted values and words', () => {
    expect(tokenizeQuery('a from:"x y" "p q" k:v')).toEqual([
      { key: null, value: 'a', quoted: false, original: 'a' },
      { key: 'from', value: 'x y', quoted: true, original: 'from:"x y"' },
      { key: null, value: 'p q', quoted: true, original: '"p q"' },
      { key: 'k', value: 'v', quoted: false, original: 'k:v' },
    ]);
  });
});

describe('withScopeAndAccount', () => {
  it('rewrites in: and account: without touching the rest', () => {
    expect(withScopeAndAccount('in:mail from:bob hello account:old', 'contacts', 'Work')).toBe('from:bob hello in:contacts account:Work');
    expect(withScopeAndAccount('in:contacts hello', 'all', null)).toBe('hello');
    expect(withScopeAndAccount('hello', 'files', 'Linus Rath')).toBe('hello in:files account:"Linus Rath"');
  });

  it('keeps in:trash because it is a folder, not a scope', () => {
    expect(withScopeAndAccount('in:trash x', 'all', null)).toBe('in:trash x');
  });
});

describe('accountMatches', () => {
  const account = { label: 'Work mail', email: 'linus@example.org', localAccountId: 'linus@example.org@mail.example.org' };
  it('matches label substrings, email prefixes and the login id', () => {
    expect(accountMatches(null, account)).toBe(true);
    expect(accountMatches('work', account)).toBe(true);
    expect(accountMatches('linus@', account)).toBe(true);
    expect(accountMatches('linus@example.org', account)).toBe(true);
    expect(accountMatches('other', account)).toBe(false);
  });
});

describe('matchesTerms', () => {
  it('requires every term as a substring of some field', () => {
    expect(matchesTerms(['bob', 'partner'], ['Bob Miller', 'bob@partner.example'])).toBe(true);
    expect(matchesTerms(['bob', 'zzz'], ['Bob Miller'])).toBe(false);
    expect(matchesTerms([], ['x'])).toBe(false);
    expect(matchesTerms(['x'], [null, undefined, ''])).toBe(false);
  });
});
