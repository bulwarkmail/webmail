import { describe, it, expect } from 'vitest';
import { buildMailboxTree, flattenMailboxTree, type MailboxNode } from '@/lib/utils';
import type { Mailbox } from '@/lib/jmap/types';

const makeMailbox = (overrides: Partial<Mailbox> = {}): Mailbox => ({
  id: 'mb-1',
  name: 'Inbox',
  sortOrder: 0,
  totalEmails: 0,
  unreadEmails: 0,
  totalThreads: 0,
  unreadThreads: 0,
  myRights: {
    mayReadItems: true,
    mayAddItems: true,
    mayRemoveItems: true,
    maySetSeen: true,
    maySetKeywords: true,
    mayCreateChild: true,
    mayRename: true,
    mayDelete: true,
    maySubmit: true,
  },
  isSubscribed: true,
  ...overrides,
});

/**
 * Builds a full-path map from a mailbox tree, matching the logic
 * used in RuleEditor for sieve fileinto folder paths.
 */
function buildMailboxPathMap(tree: MailboxNode[]): Map<string, string> {
  const pathMap = new Map<string, string>();
  const walk = (nodes: MailboxNode[], parentPath = '') => {
    for (const node of nodes) {
      const segment = node.role === 'inbox' ? 'INBOX' : node.name;
      const fullPath = parentPath ? `${parentPath}/${segment}` : segment;
      pathMap.set(node.id, fullPath);
      if (node.children.length > 0) walk(node.children, fullPath);
    }
  };
  walk(tree);
  return pathMap;
}

describe('mailbox path building for sieve fileinto', () => {
  it('should produce correct path for a root mailbox', () => {
    const mailboxes = [makeMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' })];
    const tree = buildMailboxTree(mailboxes);
    const paths = buildMailboxPathMap(tree);
    expect(paths.get('inbox')).toBe('INBOX');
  });

  it('should produce correct path for a single-level subfolder', () => {
    const mailboxes = [
      makeMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
      makeMailbox({ id: 'sub1', name: 'Projects', parentId: 'inbox' }),
    ];
    const tree = buildMailboxTree(mailboxes);
    const paths = buildMailboxPathMap(tree);
    expect(paths.get('sub1')).toBe('INBOX/Projects');
  });

  it('should produce correct path for deeply nested subfolders', () => {
    const mailboxes = [
      makeMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
      makeMailbox({ id: 'sub1', name: 'Test', parentId: 'inbox' }),
      makeMailbox({ id: 'sub2', name: 'Test2', parentId: 'sub1' }),
    ];
    const tree = buildMailboxTree(mailboxes);
    const paths = buildMailboxPathMap(tree);
    expect(paths.get('sub2')).toBe('INBOX/Test/Test2');
  });

  it('should handle multiple root-level folders', () => {
    const mailboxes = [
      makeMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
      makeMailbox({ id: 'archive', name: 'Archive', role: 'archive' }),
      makeMailbox({ id: 'sub1', name: 'Work', parentId: 'archive' }),
    ];
    const tree = buildMailboxTree(mailboxes);
    const paths = buildMailboxPathMap(tree);
    expect(paths.get('inbox')).toBe('INBOX');
    expect(paths.get('archive')).toBe('Archive');
    expect(paths.get('sub1')).toBe('Archive/Work');
  });

  it('should produce paths for all nodes in a flattened tree', () => {
    const mailboxes = [
      makeMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
      makeMailbox({ id: 'sub1', name: 'Projects', parentId: 'inbox' }),
      makeMailbox({ id: 'sub2', name: 'Active', parentId: 'sub1' }),
    ];
    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);
    const paths = buildMailboxPathMap(tree);

    // Every node in the flat list should have a path entry
    for (const node of flat) {
      expect(paths.has(node.id)).toBe(true);
    }

    expect(paths.get('inbox')).toBe('INBOX');
    expect(paths.get('sub1')).toBe('INBOX/Projects');
    expect(paths.get('sub2')).toBe('INBOX/Projects/Active');
  });

  it('uses canonical INBOX even when JMAP returns a localized inbox name', () => {
    // Stalwart returns localized display names for the inbox based on the
    // user's locale (e.g. "Entrada" for pt-BR). Sieve fileinto must still
    // target the IMAP-canonical "INBOX" so the message is filed correctly.
    const mailboxes = [
      makeMailbox({ id: 'inbox', name: 'Entrada', role: 'inbox' }),
      makeMailbox({ id: 'host', name: 'Host', parentId: 'inbox' }),
      makeMailbox({ id: 'eveo', name: 'EVEO', parentId: 'host' }),
    ];
    const tree = buildMailboxTree(mailboxes);
    const paths = buildMailboxPathMap(tree);
    expect(paths.get('inbox')).toBe('INBOX');
    expect(paths.get('host')).toBe('INBOX/Host');
    expect(paths.get('eveo')).toBe('INBOX/Host/EVEO');
  });

  it('should preserve depth info in flattened tree', () => {
    const mailboxes = [
      makeMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
      makeMailbox({ id: 'sub1', name: 'Projects', parentId: 'inbox' }),
      makeMailbox({ id: 'sub2', name: 'Alpha', parentId: 'sub1' }),
    ];
    const tree = buildMailboxTree(mailboxes);
    const flat = flattenMailboxTree(tree);
    const byId = Object.fromEntries(flat.map((n) => [n.id, n]));

    expect(byId['inbox'].depth).toBe(0);
    expect(byId['sub1'].depth).toBe(1);
    expect(byId['sub2'].depth).toBe(2);
  });
});
