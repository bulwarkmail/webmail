import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { Mailbox } from "./jmap/types";
import { debug } from "./debug";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

/**
 * Format a date/time string respecting the user's 12h/24h time format preference.
 */
export function formatDateTime(
  date: Date | string,
  timeFormat: '12h' | '24h',
  options?: {
    weekday?: 'short' | 'long';
    year?: 'numeric';
    month?: 'short' | 'long';
    day?: 'numeric';
    second?: '2-digit';
    timeZoneName?: 'short';
    dateOnly?: boolean;
  }
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return typeof date === 'string' ? date : '';

  const localeOptions: Intl.DateTimeFormatOptions = {};
  if (options?.weekday) localeOptions.weekday = options.weekday;
  if (options?.year) localeOptions.year = options.year;
  if (options?.month) localeOptions.month = options.month;
  if (options?.day) localeOptions.day = options.day;

  if (!options?.dateOnly) {
    localeOptions.hour = '2-digit';
    localeOptions.minute = '2-digit';
    localeOptions.hour12 = timeFormat === '12h';
    if (options?.second) localeOptions.second = options.second;
    if (options?.timeZoneName) localeOptions.timeZoneName = options.timeZoneName;
  }

  return d.toLocaleString(undefined, localeOptions);
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + "...";
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Types for mailbox tree
export interface MailboxNode extends Mailbox {
  children: MailboxNode[];
  depth: number;
}

// Role priority for mailbox ordering (lower number = higher priority)
const ROLE_PRIORITY: Record<string, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  junk: 4,
  spam: 4, // Treat spam same as junk
  trash: 5,
};

// Deduplicate mailboxes (e.g., "Sent" vs "Sent Mail")
function deduplicateMailboxes(mailboxes: Mailbox[]): Mailbox[] {
  const result: Mailbox[] = [];
  const removed: { id: string; name: string; matchedRole: string; parentId?: string }[] = [];

  // Group role mailboxes by account so deduplication is scoped per-account
  const rolesByAccount = new Map<string, Mailbox[]>();
  mailboxes.forEach(mb => {
    if (mb.role) {
      const key = mb.accountId || '';
      if (!rolesByAccount.has(key)) rolesByAccount.set(key, []);
      rolesByAccount.get(key)!.push(mb);
    }
  });

  // Build a set of IDs that are referenced as parents
  const referencedParentIds = new Set<string>();
  mailboxes.forEach(mb => {
    if (mb.parentId) referencedParentIds.add(mb.parentId);
  });

  // Filter out duplicates scoped to the same account
  mailboxes.forEach(mb => {
    // If this mailbox has a role, always keep it
    if (mb.role) {
      result.push(mb);
      return;
    }

    // Never deduplicate nested mailboxes — only root-level folders can be
    // duplicates of role-based mailboxes. Removing a nested folder that happens
    // to share a name with a role folder (e.g. a subfolder named "Sent") would
    // orphan its children to root level. (GitHub #118)
    if (mb.parentId) {
      result.push(mb);
      return;
    }

    // Check if this root-level mailbox is a duplicate of a role-based mailbox in the SAME account
    const accountKey = mb.accountId || '';
    const accountRoles = rolesByAccount.get(accountKey) || [];
    const lowerName = mb.name.toLowerCase();
    const matchedRole = accountRoles.find(roleMb => {
      const roleLowerName = roleMb.name.toLowerCase();
      // Check for common duplicates: "Sent Mail" vs "Sent", etc.
      return lowerName.includes(roleLowerName) || roleLowerName.includes(lowerName);
    });
    const isDuplicate = !!matchedRole;

    // Only keep if not a duplicate
    if (!isDuplicate) {
      result.push(mb);
    } else {
      removed.push({ id: mb.id, name: mb.name, matchedRole: matchedRole!.name, parentId: mb.parentId });
      // Warn if this removed mailbox is a parent of other mailboxes (orphan risk)
      if (referencedParentIds.has(mb.id)) {
        debug.warn('jmap', `[Mailbox Tree] Deduplication removed mailbox "${mb.name}" (id: ${mb.id}) which is a parent of other mailboxes. ` +
          `Matched role mailbox: "${matchedRole!.name}" (role: ${matchedRole!.role}). ` +
          `Children referencing parentId "${mb.id}" will be orphaned to root level.`
        );
      }
    }
  });

  if (removed.length > 0) {
    debug.log('jmap', `[Mailbox Tree] Deduplication removed ${removed.length} mailbox(es):`, removed);
  }

  return result;
}

// Build a hierarchical tree structure from flat mailbox array
export function buildMailboxTree(mailboxes: Mailbox[]): MailboxNode[] {
  debug.log('jmap', `[Mailbox Tree] Building tree from ${mailboxes.length} mailboxes`);

  // Deduplicate mailboxes first
  const deduplicated = deduplicateMailboxes(mailboxes);

  if (deduplicated.length !== mailboxes.length) {
    debug.log('jmap', `[Mailbox Tree] After deduplication: ${deduplicated.length} mailboxes (removed ${mailboxes.length - deduplicated.length})`);
  }

  // Separate own and shared mailboxes
  const ownMailboxes = deduplicated.filter(mb => !mb.isShared);
  const sharedMailboxes = deduplicated.filter(mb => mb.isShared);

  const mailboxMap = new Map<string, MailboxNode>();
  const rootMailboxes: MailboxNode[] = [];

  // First pass: create nodes for own mailboxes
  ownMailboxes.forEach(mailbox => {
    mailboxMap.set(mailbox.id, {
      ...mailbox,
      children: [],
      depth: 0
    });
  });

  // Helper to recursively recalculate depths after tree is built
  const recalculateDepths = (nodes: MailboxNode[], baseDepth: number) => {
    for (const node of nodes) {
      node.depth = baseDepth;
      if (node.children.length > 0) {
        recalculateDepths(node.children, baseDepth + 1);
      }
    }
  };

  // Second pass: build tree structure for own mailboxes
  const orphanedMailboxes: { id: string; name: string; parentId: string }[] = [];
  ownMailboxes.forEach(mailbox => {
    const node = mailboxMap.get(mailbox.id)!;

    if (mailbox.parentId && mailboxMap.has(mailbox.parentId)) {
      const parent = mailboxMap.get(mailbox.parentId)!;
      parent.children.push(node);
    } else {
      // Root level mailbox or orphaned mailbox
      if (mailbox.parentId) {
        orphanedMailboxes.push({ id: mailbox.id, name: mailbox.name, parentId: mailbox.parentId });
      }
      rootMailboxes.push(node);
    }
  });

  if (orphanedMailboxes.length > 0) {
    debug.warn('jmap', `[Mailbox Tree] ${orphanedMailboxes.length} orphaned mailbox(es) moved to root level (missing parent):`,
      orphanedMailboxes
    );
  }

  // Third pass: correctly calculate depths from the root down
  recalculateDepths(rootMailboxes, 0);

  // Log tree depth statistics
  const maxDepth = (nodes: MailboxNode[]): number => {
    let max = 0;
    for (const node of nodes) {
      max = Math.max(max, node.depth);
      if (node.children.length > 0) max = Math.max(max, maxDepth(node.children));
    }
    return max;
  };
  debug.log('jmap', `[Mailbox Tree] Built tree: ${rootMailboxes.length} root nodes, ` +
    `max depth: ${maxDepth(rootMailboxes)}, ` +
    `total own: ${ownMailboxes.length}, shared: ${sharedMailboxes.length}`
  );

  // If we have shared mailboxes, create a virtual "Shared Folders" parent
  if (sharedMailboxes.length > 0) {
    // Group shared mailboxes by account
    const accountGroups = new Map<string, Mailbox[]>();
    sharedMailboxes.forEach(mb => {
      const accountId = mb.accountId || 'unknown';
      if (!accountGroups.has(accountId)) {
        accountGroups.set(accountId, []);
      }
      accountGroups.get(accountId)!.push(mb);
    });

    // Create virtual nodes for each shared account
    const sharedAccountNodes: MailboxNode[] = [];

    accountGroups.forEach((accountMailboxes, accountId) => {
      // Create account nodes
      const accountMailboxMap = new Map<string, MailboxNode>();
      const accountRootNodes: MailboxNode[] = [];

      // Create nodes for this account's mailboxes
      accountMailboxes.forEach(mailbox => {
        accountMailboxMap.set(mailbox.id, {
          ...mailbox,
          children: [],
          depth: 2 // Account level is depth 1, these are depth 2
        });
      });

      // Build tree for this account's mailboxes
      accountMailboxes.forEach(mailbox => {
        const node = accountMailboxMap.get(mailbox.id)!;

        if (mailbox.parentId && accountMailboxMap.has(mailbox.parentId)) {
          const parent = accountMailboxMap.get(mailbox.parentId)!;
          parent.children.push(node);
        } else {
          accountRootNodes.push(node);
        }
      });

      // Correctly calculate depths from account root level down
      recalculateDepths(accountRootNodes, 2);

      // Create virtual account folder node
      const accountName = accountMailboxes[0]?.accountName || accountId;
      const accountNode: MailboxNode = {
        id: `shared-account-${accountId}`,
        name: accountName,
        sortOrder: 1000, // After all own folders
        totalEmails: accountMailboxes.reduce((sum, mb) => sum + mb.totalEmails, 0),
        unreadEmails: accountMailboxes.reduce((sum, mb) => sum + mb.unreadEmails, 0),
        totalThreads: 0,
        unreadThreads: 0,
        myRights: {
          mayReadItems: true,
          mayAddItems: false,
          mayRemoveItems: false,
          maySetSeen: false,
          maySetKeywords: false,
          mayCreateChild: false,
          mayRename: false,
          mayDelete: false,
          maySubmit: false,
        },
        isSubscribed: true,
        accountId: accountId,
        accountName: accountName,
        isShared: true,
        children: accountRootNodes,
        depth: 1,
      };

      sharedAccountNodes.push(accountNode);
    });

    // Create virtual "Shared Folders" root node
    const sharedFoldersNode: MailboxNode = {
      id: 'shared-folders-root',
      name: 'Shared Folders',
      sortOrder: 999, // After all own folders
      totalEmails: sharedMailboxes.reduce((sum, mb) => sum + mb.totalEmails, 0),
      unreadEmails: sharedMailboxes.reduce((sum, mb) => sum + mb.unreadEmails, 0),
      totalThreads: 0,
      unreadThreads: 0,
      myRights: {
        mayReadItems: true,
        mayAddItems: false,
        mayRemoveItems: false,
        maySetSeen: false,
        maySetKeywords: false,
        mayCreateChild: false,
        mayRename: false,
        mayDelete: false,
        maySubmit: false,
      },
      isSubscribed: true,
      isShared: true,
      children: sharedAccountNodes,
      depth: 0,
    };

    rootMailboxes.push(sharedFoldersNode);
  }

  // Smart multi-level sorting
  const sortNodes = (nodes: MailboxNode[]) => {
    nodes.sort((a, b) => {
      // 1. Priority: Own folders before shared folders
      if (a.isShared !== b.isShared) {
        return a.isShared ? 1 : -1;
      }

      // 2. Priority: Role-based ordering (inbox first, trash last, etc.)
      const aPriority = a.role ? (ROLE_PRIORITY[a.role] ?? 999) : 999;
      const bPriority = b.role ? (ROLE_PRIORITY[b.role] ?? 999) : 999;
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      // 3. Priority: Year folders (e.g., "2025", "2024") sorted numerically descending
      const aIsYear = /^\d{4}$/.test(a.name);
      const bIsYear = /^\d{4}$/.test(b.name);
      if (aIsYear && bIsYear) {
        return parseInt(b.name) - parseInt(a.name); // Descending: 2025, 2024, 2023...
      }

      // 4. Fallback: Server sortOrder
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }

      // 5. Fallback: Alphabetical by name
      return a.name.localeCompare(b.name);
    });

    // Recursively sort children
    nodes.forEach(node => {
      if (node.children.length > 0) {
        sortNodes(node.children);
      }
    });
  };

  sortNodes(rootMailboxes);

  return rootMailboxes;
}

// Flatten a mailbox tree for rendering with proper depth info
export function flattenMailboxTree(nodes: MailboxNode[]): MailboxNode[] {
  const result: MailboxNode[] = [];

  const traverse = (nodes: MailboxNode[], depth: number = 0) => {
    nodes.forEach(node => {
      result.push({ ...node, depth });
      if (node.children.length > 0) {
        traverse(node.children, depth + 1);
      }
    });
  };

  traverse(nodes);
  return result;
}