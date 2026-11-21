// A slot callback that sets host state checks what the plugin's frame hands it. The meeting link
// takes a web link only: http or https, with a host, one line, no user name, at most its length.
import { describe, expect, it, vi } from 'vitest';
import { isWebLink, linkCallback } from '../plugin-sandbox/slot-callbacks';

describe('a link callback handed to a slot', () => {
  it('passes a web link on and answers true', () => {
    const set = vi.fn();
    expect(linkCallback(set, 2000)('https://meet.jit.si/planning')).toBe(true);
    expect(set).toHaveBeenCalledWith('https://meet.jit.si/planning');
  });

  it.each([
    ['an object', { not: 'a link' }],
    ['a number', 42],
    ['nothing', undefined],
    ['null', null],
    ['an array', ['https://meet.example/a']],
    ['a link longer than the limit', `https://meet.example/${'x'.repeat(5000)}`],
    ['a link to a file share', 'smb://files.example/share'],
  ])('ignores %s and answers false', (_, value) => {
    const set = vi.fn();
    expect(linkCallback(set, 2000)(value)).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });
});

describe('what counts as a web link', () => {
  it.each([
    'https://meet.jit.si/planning-123',
    'http://meet.example.org/room?pwd=1',
    'https://meet.example.org:8443/a/b#c',
  ])('takes %s', (value) => {
    expect(isWebLink(value, 2000)).toBe(true);
  });

  const zeroWidthSpace = String.fromCharCode(0x200b);
  const rightToLeftOverride = String.fromCharCode(0x202e);
  it.each([
    ['an empty string', ''],
    ['plain words', 'Call me on 0000 000 000'],
    ['a script link', 'javascript:alert(1)'],
    ['a data link', 'data:text/html,hi'],
    ['an app scheme', 'ms-msdt:/id PCWDiagnostic'],
    ['a search scheme', 'search-ms:query=x'],
    ['a file link', 'file:///C:/Windows'],
    ['a relative path', '/meet/room'],
    ['a scheme-relative link', '//meet.example.org/room'],
    ['a link with a space', 'https://meet.example.org/a b'],
    ['a link with a line break', 'https://meet.example.org/a\r\nATTENDEE:mailto:x@example.org'],
    ['a link with a tab', 'https://meet.example.org/a\tb'],
    ['a link with a zero-width space', `https://meet.example.org/a${zeroWidthSpace}b`],
    ['a link with a direction override', `https://meet.example.org/${rightToLeftOverride}gpj.exe`],
    ['a link with a user name before the host', 'https://meet.jit.si@files.example/share'],
    ['a link with a user name and password', 'https://user:pw@meet.example.org/'],
  ])('refuses %s', (_, value) => {
    expect(isWebLink(value, 2000)).toBe(false);
  });

  it('refuses a link one character over the limit, and takes one at it', () => {
    const at = `https://meet.example.org/${'x'.repeat(2000 - 'https://meet.example.org/'.length)}`;
    expect(at).toHaveLength(2000);
    expect(isWebLink(at, 2000)).toBe(true);
    expect(isWebLink(`${at}x`, 2000)).toBe(false);
  });
});
