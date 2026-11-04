import { describe, expect, it } from 'vitest';
import { ADMIN_PAGES, type AdminPageGroup } from '../admin-nav';
import { OUTGOING_HOSTS } from '../outgoing-hosts-registry';

// The outgoing-hosts list tells admins where to switch each host off. Those
// directions have to name pages that exist, under the sidebar heading they
// sit under (top-level pages as "Admin > ...").

const HEADINGS: Record<string, AdminPageGroup> = {
  Admin: 'top',
  Users: 'organisation',
  Extensions: 'extensions',
  System: 'system',
};

describe('admin directions in the outgoing-hosts registry', () => {
  const texts = OUTGOING_HOSTS.flatMap((h) => [h.usedBy, h.off, h.inMode].map((text) => ({ id: h.id, text })));

  it('name an existing page under its sidebar heading', () => {
    const problems: string[] = [];
    let found = 0;
    for (const { id, text } of texts) {
      for (const m of text.matchAll(/\b(Admin|Users|Extensions|System) > /g)) {
        found++;
        const rest = text.slice(m.index! + m[0].length);
        const page = ADMIN_PAGES.find((p) => rest.startsWith(p.label));
        if (!page) {
          problems.push(`${id}: no admin page at "${m[0]}${rest.slice(0, 30)}"`);
          continue;
        }
        if (page.group !== HEADINGS[m[1]]) {
          problems.push(`${id}: "${page.label}" is not under ${m[1]}`);
          continue;
        }
        const after = rest.slice(page.label.length);
        if (after.startsWith(' > ') && !page.sections.some((s) => after.slice(3).startsWith(s.title))) {
          problems.push(`${id}: no section "${after.slice(3, 30)}" on ${page.label}`);
        }
      }
    }
    expect(found).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
