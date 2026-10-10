import { describe, it, expect, beforeEach } from 'vitest';
import { useEmailStore } from '../email-store';

function makeEmail(id: string, threadId = `thread-${id}`) {
  return {
    id,
    threadId,
    mailboxIds: { inbox: true },
    keywords: {},
    size: 100,
    receivedAt: new Date().toISOString(),
    from: [{ name: 'Test', email: 'test@example.com' }],
    to: [{ name: 'User', email: 'user@example.com' }],
    subject: `Email ${id}`,
    preview: 'preview',
    hasAttachment: false,
    textBody: [],
    htmlBody: [],
    bodyValues: {},
  };
}

describe('email-store selection', () => {
  beforeEach(() => {
    useEmailStore.setState({
      emails: [makeEmail('a'), makeEmail('b'), makeEmail('c'), makeEmail('d'), makeEmail('e')],
      selectedEmailKeys: new Set(),
      lastSelectedEmailKey: null,
      selectedEmail: null,
    });
  });

  describe('toggleEmailSelection', () => {
    it('should add email to selection', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'b' });
      expect(useEmailStore.getState().selectedEmailKeys.has('b')).toBe(true);
      expect(useEmailStore.getState().lastSelectedEmailKey).toBe('b');
    });

    it('should remove email from selection when toggled again', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'b' });
      useEmailStore.getState().toggleEmailSelection({ id: 'b' });
      expect(useEmailStore.getState().selectedEmailKeys.has('b')).toBe(false);
    });

    it('should support selecting multiple emails', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'a' });
      useEmailStore.getState().toggleEmailSelection({ id: 'c' });
      const ids = useEmailStore.getState().selectedEmailKeys;
      expect(ids.has('a')).toBe(true);
      expect(ids.has('c')).toBe(true);
      expect(ids.size).toBe(2);
    });
  });

  describe('selectRangeEmails', () => {
    it('should select range from last selected to target (forward)', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'b' }); // anchor at index 1
      useEmailStore.getState().selectRangeEmails({ id: 'd' }); // target at index 3
      const ids = useEmailStore.getState().selectedEmailKeys;
      expect(ids.has('b')).toBe(true);
      expect(ids.has('c')).toBe(true);
      expect(ids.has('d')).toBe(true);
      expect(ids.size).toBe(3);
    });

    it('should select range backward', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'd' }); // anchor at index 3
      useEmailStore.getState().selectRangeEmails({ id: 'b' }); // target at index 1
      const ids = useEmailStore.getState().selectedEmailKeys;
      expect(ids.has('b')).toBe(true);
      expect(ids.has('c')).toBe(true);
      expect(ids.has('d')).toBe(true);
      expect(ids.size).toBe(3);
    });

    it('should use first email as anchor when no previous selection', () => {
      useEmailStore.getState().selectRangeEmails({ id: 'c' }); // no anchor → uses first email 'a'
      const ids = useEmailStore.getState().selectedEmailKeys;
      expect(ids.has('a')).toBe(true);
      expect(ids.has('b')).toBe(true);
      expect(ids.has('c')).toBe(true);
      expect(ids.size).toBe(3);
    });

    it('should add to existing selection', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'a' });
      useEmailStore.getState().toggleEmailSelection({ id: 'b' }); // anchor now at 'b'
      useEmailStore.getState().selectRangeEmails({ id: 'd' });
      const ids = useEmailStore.getState().selectedEmailKeys;
      // 'a' still selected, plus b-d range
      expect(ids.has('a')).toBe(true);
      expect(ids.has('b')).toBe(true);
      expect(ids.has('c')).toBe(true);
      expect(ids.has('d')).toBe(true);
      expect(ids.size).toBe(4);
    });

    it('should handle single-item range', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'c' });
      useEmailStore.getState().selectRangeEmails({ id: 'c' });
      const ids = useEmailStore.getState().selectedEmailKeys;
      expect(ids.has('c')).toBe(true);
      expect(ids.size).toBe(1);
    });
  });

  describe('selectAllEmails', () => {
    it('should select all emails', () => {
      useEmailStore.getState().selectAllEmails();
      expect(useEmailStore.getState().selectedEmailKeys.size).toBe(5);
    });
  });

  describe('clearSelection', () => {
    it('should clear all selections and reset anchor', () => {
      useEmailStore.getState().toggleEmailSelection({ id: 'a' });
      useEmailStore.getState().toggleEmailSelection({ id: 'b' });
      useEmailStore.getState().clearSelection();
      expect(useEmailStore.getState().selectedEmailKeys.size).toBe(0);
      expect(useEmailStore.getState().lastSelectedEmailKey).toBeNull();
    });
  });
});
