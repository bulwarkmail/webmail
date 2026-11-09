import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChangelogEntries, ChangelogNotes } from '../changelog';
import { parseChangelog } from '@/lib/admin/changelog-markdown';

describe('parseChangelog', () => {
  it('reads headings, lists, paragraphs, code, bold and links', () => {
    expect(parseChangelog('### Fixed\n- Keep the **header**\n  intact. #31\n- Use `Intl`\n\nSee [the docs](https://example.org/a).\n\n```\n<b>x</b>\n```')).toEqual([
      { t: 'heading', c: [{ t: 'text', v: 'Fixed' }] },
      { t: 'list', ordered: false, items: [
        [{ t: 'text', v: 'Keep the ' }, { t: 'strong', c: [{ t: 'text', v: 'header' }] }, { t: 'text', v: ' intact. #31' }],
        [{ t: 'text', v: 'Use ' }, { t: 'code', v: 'Intl' }],
      ] },
      { t: 'para', c: [{ t: 'text', v: 'See ' }, { t: 'link', href: 'https://example.org/a', c: [{ t: 'text', v: 'the docs' }] }, { t: 'text', v: '.' }] },
      { t: 'code', v: '<b>x</b>' },
    ]);
  });

  it('keeps links to anything but http(s) as their text', () => {
    expect(parseChangelog('[click](javascript:alert`1`) [mail](mailto:a@b.c)')).toEqual([
      { t: 'para', c: [{ t: 'text', v: 'click' }, { t: 'text', v: ' ' }, { t: 'text', v: 'mail' }] },
    ]);
  });

  it('splits a numbered list from a bulleted one', () => {
    expect(parseChangelog('1. One\n2. Two\n- Three').map((b) => b.t === 'list' && b.ordered)).toEqual([true, false]);
  });
});

describe('ChangelogNotes', () => {
  it('shows HTML in the notes as text and never as elements', () => {
    const { container } = render(<ChangelogNotes markdown={'- <img src=x onerror="alert(1)"> and <script>alert(2)</script>\n\n<a href="javascript:alert(3)">x</a>'} />);
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('opens links in a new tab without the opener', () => {
    render(<ChangelogNotes markdown="See [the docs](https://example.org/a)" />);
    const link = screen.getByRole('link', { name: 'the docs' });
    expect(link).toHaveAttribute('href', 'https://example.org/a');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('ChangelogEntries', () => {
  it('lists each version with its flags, and says when one has no notes', () => {
    render(<ChangelogEntries entries={[
      { version: '1.3.0', publishedAt: null, changelog: '### Security\n- Escape names', notes: { security: true, breaking: false } },
      { version: '1.2.0', publishedAt: null, changelog: null },
    ]} />);
    const items = screen.getAllByRole('listitem').filter((li) => li.parentElement?.tagName === 'OL');
    expect(items.map((li) => li.querySelector('span')?.textContent)).toEqual(['v1.3.0', 'v1.2.0']);
    expect(items[0]).toHaveTextContent('Security');
    expect(items[0]).toHaveTextContent('Escape names');
    expect(items[1]).toHaveTextContent('No notes for this version.');
  });
});
