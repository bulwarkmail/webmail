import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { setNoThirdPartyTraffic } from '@/lib/third-party-mode';
import { LIVE_REGION_IDS } from '@/lib/announce';

// Every toast is also read out through the app-wide live regions
// (lib/announce), so its title is in the page twice for a few seconds.
// Text queries look at what is on screen; tests of the announcements read
// the regions by id.
configure({
  defaultIgnore: `script, style, #${LIVE_REGION_IDS.polite}, #${LIVE_REGION_IDS.assertive}`,
});

// jsdom does not implement matchMedia; components that read media queries
// (e.g. responsive layout hooks) call it during render. Provide a minimal
// no-match stub so those components can render under test.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
}

// Node 25+ ships its own localStorage global, which shadows jsdom's under
// vitest; without --localstorage-file it is an empty object with no Storage
// methods. The zustand persist middleware writes through it on every
// setState and several stores read from it directly, so provide a minimal
// in-memory Storage when the real one is missing or unusable.
if (typeof window !== 'undefined' && typeof window.localStorage?.getItem !== 'function') {
  const backing = new Map<string, string>();
  const localStorage: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key: string) => backing.get(key) ?? null,
    key: (index: number) => [...backing.keys()][index] ?? null,
    removeItem: (key: string) => {
      backing.delete(key);
    },
    setItem: (key: string, value: string) => {
      backing.set(key, String(value));
    },
  };
  Object.defineProperty(window, 'localStorage', {
    value: localStorage,
    configurable: true,
  });
}

// The page skeletons keep the server's markup un-hydrated
// (components/boot-skeleton/server-markup.tsx) and tell a server render by
// there being no window. jsdom has one, so a server render in a test says so.
vi.mock('react-dom/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/server')>();
  const asServer = <A extends unknown[], R>(render: (...args: A) => R) => (...args: A): R => {
    const g = globalThis as { __bulwarkServerRender?: boolean };
    const before = g.__bulwarkServerRender;
    g.__bulwarkServerRender = true;
    try { return render(...args); } finally { g.__bulwarkServerRender = before; }
  };
  return { ...actual, renderToString: asServer(actual.renderToString), renderToStaticMarkup: asServer(actual.renderToStaticMarkup) };
});

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date | string) => String(d),
    relativeTime: (d: Date | string) => String(d),
    number: (n: number) => String(n),
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useParams: () => ({ locale: 'en' }),
  usePathname: () => '/en',
}));

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en',
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

// The browser treats the no-third-party mode as on until the config says
// otherwise (#903). Tests start from a config that says off; the tests of
// the mode set it themselves.
beforeEach(() => {
  setNoThirdPartyTraffic(false);
});

afterEach(() => {
  cleanup();
});
