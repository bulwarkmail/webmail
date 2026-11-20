// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FolderPlanner, assignRoles, roleForFolder } from '../folder-roles';
import { keywordsFromFlags } from '../keywords';
import type { SourceFolder, TargetMailbox } from '../types';

const f = (path: string, extra: Partial<SourceFolder> = {}): SourceFolder => ({ path, delimiter: '/', noselect: false, ...extra });

describe('folder roles', () => {
  it('uses SPECIAL-USE first', () => {
    expect(roleForFolder(f('Gesendet', { specialUse: '\\Sent' }))).toBe('sent');
    expect(roleForFolder(f('Whatever/Deep', { specialUse: '\\Archive' }))).toBe('archive');
    expect(roleForFolder(f('INBOX'))).toBe('inbox');
  });

  it('maps the usual Open-Xchange, Kopano and Outlook names in English and German', () => {
    const cases: Record<string, string> = {
      'Sent Items': 'sent', 'Sent Messages': 'sent', 'Gesendete Objekte': 'sent', 'Gesendete Elemente': 'sent',
      'Deleted Items': 'trash', 'Gelöschte Objekte': 'trash', 'Gelöschte Elemente': 'trash',
      'Junk E-Mail': 'junk', Spam: 'junk', 'Junk-E-Mail': 'junk',
      Entwürfe: 'drafts', Drafts: 'drafts', Archive: 'archive', Archiv: 'archive',
    };
    for (const [name, role] of Object.entries(cases)) expect(roleForFolder(f(name)), name).toBe(role);
    // Open-Xchange keeps them under INBOX, with its own delimiter.
    expect(roleForFolder({ path: 'INBOX.Sent Items', delimiter: '.', noselect: false })).toBe('sent');
    // Deeper down a name is just a name.
    expect(roleForFolder(f('Projects/Archive'))).toBeNull();
  });

  it('gives each role to one folder, SPECIAL-USE winning over a name', () => {
    const roles = assignRoles([f('Sent'), f('Sent Items', { specialUse: '\\Sent' }), f('Trash'), f('Deleted Items')]);
    expect(roles.get('Sent Items')).toBe('sent');
    expect(roles.has('Sent')).toBe(false);
    expect(roles.get('Trash')).toBe('trash');
    expect(roles.has('Deleted Items')).toBe(false);
  });

  it('creates the hierarchy, reusing same-name folders under the same parent', async () => {
    const mailboxes: TargetMailbox[] = [
      { id: 'inbox', name: 'Inbox', parentId: null, role: 'inbox' },
      { id: 'sent', name: 'Sent', parentId: null, role: 'sent' },
      { id: 'proj', name: 'Projects', parentId: null, role: null },
    ];
    const created: [string, string | null][] = [];
    const planner = new FolderPlanner(
      [f('INBOX'), f('INBOX/Clients'), f('Sent Items'), f('Sent Items/2019'), f('Projects'), f('Projects/A/B')],
      mailboxes,
      { createMailbox: async (name, parentId) => { created.push([name, parentId]); return `new-${name}`; } },
    );
    expect(await planner.resolve(f('INBOX'))).toBe('inbox');
    expect(await planner.resolve(f('Sent Items'))).toBe('sent');
    expect(await planner.resolve(f('INBOX/Clients'))).toBe('new-Clients');
    expect(await planner.resolve(f('Sent Items/2019'))).toBe('new-2019');
    expect(await planner.resolve(f('Projects/A/B'))).toBe('new-B');
    expect(created).toEqual([['Clients', 'inbox'], ['2019', 'sent'], ['A', 'proj'], ['B', 'new-A']]);
    expect(planner.createdCount).toBe(4);
  });
});

describe('flags to keywords', () => {
  it('maps system flags, keeps valid keywords and drops \\Deleted and \\Recent', () => {
    expect(keywordsFromFlags(['\\Seen', '\\Flagged', '\\Answered', '\\Draft', '$Forwarded', '\\Deleted', '\\Recent', 'Work', '$label1', '\\Unknown', 'bad"word']))
      .toEqual({ $seen: true, $flagged: true, $answered: true, $draft: true, $forwarded: true, work: true, $label1: true });
  });
});
