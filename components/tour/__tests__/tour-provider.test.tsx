import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Which steps a run of the tour counts, and where it takes the user.

const env = vi.hoisted(() => ({
  phone: true,
  proActive: false,
  pathname: '/mail/folder/inbox',
  push: vi.fn(),
  command: vi.fn(),
}));

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: env.push }),
  usePathname: () => env.pathname,
}));
vi.mock('@/hooks/use-media-query', () => ({
  useMediaQuery: () => env.phone,
  useIsMobile: () => env.phone,
}));
vi.mock('@/lib/app-commands', () => ({ requestAppCommand: env.command }));
vi.mock('@/components/pro/pro-interface-redirect', () => ({ useProInterfaceActive: () => env.proActive }));
vi.mock('../tour-overlay', () => ({ TourOverlay: () => null }));
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ isDemoMode: true, client: { supportsContacts: () => true } }),
}));
vi.mock('@/stores/calendar-store', () => ({
  useCalendarStore: (sel: (s: unknown) => unknown) => sel({ supportsCalendar: true }),
}));
vi.mock('@/stores/webdav-store', () => ({
  useWebDAVStore: (sel: (s: unknown) => unknown) => sel({ supportsWebDAV: true }),
}));
vi.mock('@/stores/policy-store', () => ({
  usePolicyStore: (sel: (s: unknown) => unknown) => sel({ isFeatureEnabled: () => true }),
}));
const updateSetting = vi.fn();
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ tourCompleted: false, showOnboardingOnNewDevices: false, updateSetting }),
}));

const { TourProvider, useTour } = await import('../tour-provider');
const { getTourSteps, proTabOfTourStep } = await import('../tour-steps');
const { useProTabStore } = await import('@/stores/pro-tab-store');

let api: ReturnType<typeof useTour>;
function Probe() {
  api = useTour();
  const step = api.steps[api.currentStep];
  return <p data-testid="probe">{api.isActive ? `${api.currentStep + 1}/${api.totalSteps}/${step?.id}` : 'off'}</p>;
}
const probe = () => screen.getByTestId('probe').textContent;

beforeEach(() => {
  env.phone = true;
  env.proActive = false;
  env.pathname = '/mail/folder/inbox';
  env.push.mockClear();
  env.command.mockClear();
  localStorage.clear();
});

function start() {
  render(<TourProvider><Probe /></TourProvider>);
  act(() => api.startTour());
}

describe('tour run', () => {
  it('counts only the steps a phone shows, starting at step 1', () => {
    start();
    const shown = getTourSteps({ isDemoMode: true, supportsCalendar: true, supportsWebDAV: true, supportsContacts: true, touch: true, phone: true });
    expect(probe()).toBe(`1/${shown.length}/compose`);
  });

  it('drops a step that has nothing to point at, so the count stays whole', () => {
    start();
    const total = api.totalSteps;
    act(() => api.nextStep());
    expect(probe()).toBe(`2/${total}/search`);
    act(() => api.skipStep(1));
    expect(probe()).toBe(`2/${total - 1}/email-list`);
    act(() => api.skipStep(-1));
    expect(probe()).toBe(`1/${total - 2}/compose`);
  });

  it('closes the phone reader for Mail steps but not for the reader step', () => {
    start();
    expect(env.command).toHaveBeenLastCalledWith('show-list');
    while (api.steps[api.currentStep].id !== 'email-viewer') act(() => api.nextStep());
    env.command.mockClear();
    env.pathname = '/mail/message/m1';
    act(() => api.nextStep());
    // The next Mail step (Calendar in the tab bar) needs the list back.
    expect(api.steps[api.currentStep].id).toBe('nav-calendar');
    expect(env.command).toHaveBeenCalledWith('show-list');
    env.command.mockClear();
    act(() => api.prevStep());
    expect(env.command).not.toHaveBeenCalled();
  });

  it('takes the user to the app of the step', () => {
    start();
    while (api.steps[api.currentStep].id !== 'calendar-view') act(() => api.nextStep());
    expect(env.push).toHaveBeenLastCalledWith('/calendar');
    // File storage is shown over Files.
    while (api.steps[api.currentStep].id !== 'nav-files') act(() => api.nextStep());
    expect(env.push).toHaveBeenLastCalledWith('/files');
  });

  it('leaves a desktop reader open', () => {
    env.phone = false;
    start();
    expect(env.command).not.toHaveBeenCalled();
  });

  // After the tour Mail was a dead end on a phone: the composer the tour had
  // opened left only the empty reading pane. Ending the tour, whichever way,
  // tells Mail to close what the tour opened.
  it.each([true, false])('tells Mail the tour is over when it is skipped (phone %s)', (phone) => {
    env.phone = phone;
    start();
    while (api.steps[api.currentStep].id !== 'compose-open') act(() => api.nextStep());
    env.command.mockClear();
    act(() => api.stopTour());
    expect(probe()).toBe('off');
    expect(env.command).toHaveBeenCalledWith('tour-end');
  });

  it('tells Mail the tour is over when it is finished', () => {
    start();
    while (api.currentStep < api.totalSteps - 1) act(() => api.nextStep());
    env.command.mockClear();
    act(() => api.nextStep());
    expect(probe()).toBe('off');
    expect(env.command).toHaveBeenCalledWith('tour-end');
  });

  it('tells Mail the tour is over when the last step has nothing to point at', () => {
    start();
    while (api.currentStep < api.totalSteps - 1) act(() => api.nextStep());
    env.command.mockClear();
    act(() => api.skipStep(1));
    expect(probe()).toBe('off');
    expect(env.command).toHaveBeenCalledWith('tour-end');
  });
});

describe('tour under the Pro shell', () => {
  const stepTo = (id: string) => {
    for (let i = 0; i < 30 && api.steps[api.currentStep]?.id !== id; i++) act(() => api.nextStep());
  };

  beforeEach(() => {
    env.phone = false;
    env.proActive = true;
    // Not /pro: the address the focused tab wrote can reach the router.
    env.pathname = '/calendar/month/2026-11-03';
    useProTabStore.setState({ tabs: [{ id: 'home-mail', kind: 'mail', labelKey: 'mail', closeable: false, paneId: 'main' }], activeTabId: 'home-mail', activeSplitTabId: null, focusedPaneId: 'main', loadedTabIds: ['home-mail'] });
  });

  it('opens the tab of each step instead of leaving the Pro route', () => {
    start();
    stepTo('calendar-view');
    const focused = () => {
      const s = useProTabStore.getState();
      return s.tabs.find((t) => t.id === s.activeTabId)?.kind;
    };
    expect(focused()).toBe('calendar');
    expect(env.push).not.toHaveBeenCalled();
  });

  it('leaves the composer step in the compose tab it just opened', () => {
    expect(proTabOfTourStep({ target: '[data-tour="composer"]' })).toBeNull();
    expect(proTabOfTourStep({ target: '[data-tour="sidebar"]' })).toBe('mail');
    expect(proTabOfTourStep({ target: 'x', page: '/settings' })).toBe('settings');
  });
});
