import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveExternalLink = vi.hoisted(() => vi.fn(async (ctx: { href: string }) => ctx.href));
vi.mock('@/lib/plugin-hook-result', () => ({ resolveExternalLink }));

import { OrgAnnouncement } from '@/components/org/org-announcement';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY, type OrganisationPolicy } from '@/lib/admin/organisation-policy';
import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';

type Announcement = OrganisationPolicy['announcement'];

function setAnnouncement(announcement: Partial<Announcement>) {
  usePolicyStore.setState({
    policy: {
      ...DEFAULT_POLICY,
      organisation: {
        ...DEFAULT_ORGANISATION_POLICY,
        announcement: { ...DEFAULT_ORGANISATION_POLICY.announcement, id: 'n1', text: { en: 'Mail is down tonight' }, ...announcement },
      },
    },
  });
}

describe('OrgAnnouncement', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ activeAccountId: 'acc-1' });
  });
  afterEach(() => {
    vi.useRealTimers();
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY } });
  });

  it('shows nothing without an announcement', () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY } });
    render(<OrgAnnouncement />);
    expect(screen.queryByTestId('org-announcement')).toBeNull();
  });

  it('shows the text, and reads a critical one out as an alert after it is in the page', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setAnnouncement({ severity: 'critical' });
    render(<OrgAnnouncement />);
    const banner = screen.getByTestId('org-announcement');
    expect(banner.textContent).toContain('Mail is down tonight');
    const live = screen.getByTestId('org-announcement-live');
    expect(live.getAttribute('role')).toBe('alert');
    // Empty when it appears, filled a moment later: only a change is announced.
    expect(live.textContent).toBe('');
    act(() => { vi.advanceTimersByTime(200); });
    expect(live.textContent).toBe('severity_critical: Mail is down tonight');
  });

  it('goes away at its end time without a reload', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-02T09:59:00Z'));
    setAnnouncement({ id: 'n-end', endsAt: '2026-11-02T10:00:00.000Z' });
    render(<OrgAnnouncement />);
    expect(screen.getByTestId('org-announcement')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(61_000); });
    expect(screen.queryByTestId('org-announcement')).toBeNull();
  });

  it('shows one that arrives with a refetch after its start, in a tab open since before', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY } });
    render(<OrgAnnouncement />);
    expect(screen.queryByTestId('org-announcement')).toBeNull();
    // Two hours later a refetch brings an announcement that started at 09:00.
    vi.setSystemTime(new Date('2026-11-02T10:05:00Z'));
    act(() => setAnnouncement({ id: 'n-late', startsAt: '2026-11-02T09:00:00.000Z', endsAt: '2026-11-02T12:00:00.000Z' }));
    expect(screen.getByTestId('org-announcement')).toBeTruthy();
  });

  it('appears at its start time without a reload', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-02T07:59:00Z'));
    setAnnouncement({ id: 'n-start', startsAt: '2026-11-02T08:00:00.000Z' });
    render(<OrgAnnouncement />);
    expect(screen.queryByTestId('org-announcement')).toBeNull();
    act(() => { vi.advanceTimersByTime(61_000); });
    expect(screen.getByTestId('org-announcement')).toBeTruthy();
  });

  it('stays closed after closing, and shows again once the admin edits it', () => {
    setAnnouncement({ id: 'n-dismiss' });
    const { unmount } = render(<OrgAnnouncement />);
    fireEvent.click(screen.getByTestId('org-announcement-dismiss'));
    expect(screen.queryByTestId('org-announcement')).toBeNull();
    unmount();
    render(<OrgAnnouncement />);
    expect(screen.queryByTestId('org-announcement')).toBeNull();
    act(() => setAnnouncement({ id: 'n-dismiss', text: { en: 'Mail is down until 6' } }));
    expect(screen.getByTestId('org-announcement').textContent).toContain('until 6');
  });

  it('has no close button when the admin made it permanent', () => {
    setAnnouncement({ id: 'n-perm', dismissible: false });
    render(<OrgAnnouncement />);
    expect(screen.queryByTestId('org-announcement-dismiss')).toBeNull();
  });

  it('opens links through the link check', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    setAnnouncement({ id: 'n-link', text: { en: 'Status: https://status.example.org' } });
    render(<OrgAnnouncement />);
    fireEvent.click(screen.getByRole('link'));
    await act(async () => {});
    expect(resolveExternalLink).toHaveBeenCalledWith(expect.objectContaining({ href: 'https://status.example.org' }));
    expect(open).toHaveBeenCalledWith('https://status.example.org', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('is read out once per page load, then is a plain region', () => {
    setAnnouncement({ id: 'n-once' });
    const { unmount } = render(<OrgAnnouncement />);
    expect(screen.getByTestId('org-announcement').getAttribute('role')).toBe('region');
    expect(screen.getByTestId('org-announcement-live').getAttribute('role')).toBe('status');
    unmount();
    render(<OrgAnnouncement />);
    expect(screen.queryByTestId('org-announcement-live')).toBeNull();
  });
});
