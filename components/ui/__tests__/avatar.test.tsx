import { render, waitFor, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Avatar } from '../avatar';
import { useAuthStore } from '@/stores/auth-store';
import { useContactStore } from '@/stores/contact-store';
import { useAccountStore } from '@/stores/account-store';
import { useFaviconRefreshStore } from '@/stores/favicon-refresh-store';
import { clearContactPhotoCache } from '@/lib/contact-photo-cache';
import type { ContactCard } from '@/lib/jmap/types';
import { setNoThirdPartyTraffic } from '@/lib/third-party-mode';
import { useSettingsStore } from '@/stores/settings-store';

describe('Avatar', () => {
  it('renders initials from full name', () => {
    const { container } = render(<Avatar name="Alice Smith" />);
    expect(container.textContent).toBe('AS');
  });

  it('renders two letters from single-word name', () => {
    const { container } = render(<Avatar name="Alice" />);
    expect(container.textContent).toBe('AL');
  });

  describe('Han-character names', () => {
    // Unspaced Han names carry surname + given name in one string, so the
    // Western rule would show the surname and half the given name; the
    // given name itself is what reads naturally.
    it('shows the given name of a three-character name', () => {
      const { container } = render(<Avatar name="王阳明" />);
      expect(container.textContent).toBe('阳明');
    });

    it('shows both characters of a two-character name', () => {
      const { container } = render(<Avatar name="陈阳" />);
      expect(container.textContent).toBe('陈阳');
    });

    it('skips a compound surname', () => {
      const { container } = render(<Avatar name="司马光" />);
      expect(container.textContent).toBe('光');
      const { container: compoundLong } = render(<Avatar name="欧阳阳明" />);
      expect(compoundLong.textContent).toBe('阳明');
    });

    it('joins spaced Han segments before taking the given name', () => {
      const { container } = render(<Avatar name="王 阳明" />);
      expect(container.textContent).toBe('阳明');
    });

    it('keeps the Western rule for mixed or non-Han names', () => {
      const { container } = render(<Avatar name="Zhang San" />);
      expect(container.textContent).toBe('ZS');
      // Not every character is Han, so this is not a Han name; the Western
      // first-letter-of-each-word rule applies (王 has no uppercase).
      const { container: mixed } = render(<Avatar name="Kevin 王" />);
      expect(mixed.textContent).toBe('K王');
    });

    it('falls back to the Western rule for 4+ characters without a compound surname', () => {
      // A 4-character Han string's surname/given-name split is not guessable
      // (Japanese kanji names are 1+3 or 2+2), so slicing at a fixed point
      // would produce a cross-boundary pair like 田太 - neither 山田 the
      // surname nor 太郎 the given name. The plain leading characters are
      // the safer display.
      const { container } = render(<Avatar name="山田太郎" />);
      expect(container.textContent).toBe('山田');
      const { container: longer } = render(<Avatar name="亚历山大大帝" />);
      expect(longer.textContent).toBe('亚历');
    });

    it('keeps the Han path for a 4-character name with a compound surname', () => {
      const { container } = render(<Avatar name="欧阳阳明" />);
      expect(container.textContent).toBe('阳明');
    });

    it('pins the known 3-character trade-off: a 2+1 Japanese name slices cross-boundary', () => {
      // Chinese 1+2 is the dominant 3-character shape (this rule's reason to
      // exist) and Japanese 1+2 (林太郎 → 太郎) cuts the same way, but
      // Japanese 2+1 (田中実) cannot be told apart from Chinese 1+2 without a
      // surname dictionary. The majority case wins; this test documents the
      // accepted output rather than blessing it.
      const { container } = render(<Avatar name="田中実" />);
      expect(container.textContent).toBe('中実');
    });
  });

  it('reads the part before the @ as a name when there is no name', () => {
    const { container } = render(<Avatar email="bob@example.com" />);
    expect(container.textContent).toBe('BO');
    const { container: dotted } = render(<Avatar email="max.mustermann@example.com" />);
    expect(dotted.textContent).toBe('MM');
  });

  it('renders "?" when no name or email', () => {
    const { container } = render(<Avatar />);
    expect(container.textContent).toBe('?');
  });

  it('produces consistent background color for same input', () => {
    const { container: a } = render(<Avatar name="Alice" />);
    const { container: b } = render(<Avatar name="Alice" />);
    const colorA = (a.firstChild as HTMLElement).style.backgroundColor;
    const colorB = (b.firstChild as HTMLElement).style.backgroundColor;
    expect(colorA).toBe(colorB);
  });

  describe('one look per person', () => {
    const look = (el: Element) => {
      const div = (el as HTMLElement).firstElementChild as HTMLElement;
      return { text: div.textContent, color: div.style.backgroundColor };
    };

    afterEach(() => {
      useAccountStore.setState({ accounts: [] });
    });

    it('shows the same letters and colour whether the address comes as the name or the email', () => {
      // The message header passes no name, the contact card passes the address as the name.
      const header = look(render(<Avatar email="xaver@litzlbauer.de" disableImages />).container);
      const card = look(render(<Avatar name="xaver@litzlbauer.de" email="xaver@litzlbauer.de" disableImages />).container);
      const nameOnly = look(render(<Avatar name="Xaver@Litzlbauer.de" disableImages />).container);
      expect(card).toEqual(header);
      expect(nameOnly).toEqual(header);
    });

    it('keeps the colour of an address whether or not the name is known', () => {
      const named = look(render(<Avatar name="Xaver Litzlbauer" email="xaver@litzlbauer.de" disableImages />).container);
      const bare = look(render(<Avatar email="Xaver@litzlbauer.de" disableImages />).container);
      expect(named.color).toBe(bare.color);
      // Another address does get another colour.
      const other = look(render(<Avatar email="bob@example.com" disableImages />).container);
      expect(other.color).not.toBe(bare.color);
    });

    it('gives a signed-in account its account colour everywhere', () => {
      useAccountStore.setState({ accounts: [{ email: 'me@example.com', username: 'me', avatarColor: '#0d9488' } as never] });
      const { container } = render(<Avatar name="Me" email="ME@example.com" disableImages />);
      expect((container.firstElementChild as HTMLElement).style.backgroundColor).toBe('rgb(13, 148, 136)');
    });
  });

  describe('contact photos', () => {
    const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
    const fetchBlob = vi.fn(async () => jpeg());
    // Stalwart 1.0 returns the photo as a blob (contact/get.rs, EmbeddedBlobIds).
    const ann: ContactCard = {
      id: 'c1',
      addressBookIds: {},
      accountId: 'a',
      emails: { e0: { address: 'ann@example.com' } },
      media: { photo: { kind: 'photo', blobId: 'dbcAnn', mediaType: 'image/jpeg' } },
    };
    const img = (container: HTMLElement) => container.querySelector('img');

    beforeEach(() => {
      clearContactPhotoCache();
      fetchBlob.mockReset();
      fetchBlob.mockImplementation(async () => jpeg());
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:photo');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      useAuthStore.setState({ client: { fetchBlob } as never });
    });

    afterEach(() => {
      useAuthStore.setState({ client: null });
      useContactStore.setState({ contacts: [] });
      clearContactPhotoCache();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('downloads a Stalwart 1.0 blob photo from the card\'s account', async () => {
      const { container } = render(
        <Avatar name="Ann" contactPhoto={{ blobId: 'dbcAnn', mediaType: 'image/jpeg', accountId: 'shared-1' }} />,
      );

      await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('blob:photo'));
      expect(fetchBlob).toHaveBeenCalledWith('dbcAnn', 'photo', 'image/jpeg', 'shared-1');
    });

    it('shows a Stalwart 0.16 data: photo without downloading anything', () => {
      const { container } = render(<Avatar name="Ann" contactPhoto={{ uri: 'data:image/jpeg;base64,/9j/' }} />);
      expect(img(container)?.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/');
      expect(fetchBlob).not.toHaveBeenCalled();
    });

    it('looks a sender up among the contacts and downloads one copy for every avatar', async () => {
      useContactStore.setState({ contacts: [ann] });
      const { container } = render(
        <>
          <Avatar name="Ann" email="Ann@Example.com" />
          <Avatar name="Ann" email="ann@example.com" />
        </>,
      );

      await waitFor(() => expect(container.querySelectorAll('img[src="blob:photo"]')).toHaveLength(2));
      expect(fetchBlob).toHaveBeenCalledTimes(1);
    });

    it('borrows no other card\'s photo when the contact has none', () => {
      useContactStore.setState({ contacts: [ann] });
      const { container } = render(<Avatar name="Other Ann" email="ann@example.com" contactPhoto={null} />);
      expect(img(container)).toBeNull();
      expect(fetchBlob).not.toHaveBeenCalled();
    });

    it('waits until the avatar is on screen', async () => {
      let report: ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | undefined;
      vi.stubGlobal('IntersectionObserver', class {
        constructor(callback: typeof report) { report = callback; }
        observe() {}
        unobserve() {}
        disconnect() {}
      });
      const { container } = render(<Avatar name="Ann" contactPhoto={{ blobId: 'dbcAnn', mediaType: 'image/jpeg' }} />);
      expect(fetchBlob).not.toHaveBeenCalled();

      act(() => report?.([{ target: container.firstChild as Element, isIntersecting: true }]));

      await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('blob:photo'));
      expect(fetchBlob).toHaveBeenCalledTimes(1);
    });

    it('shows initials when the download fails, after trying once more', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      fetchBlob.mockRejectedValue(new Error('Failed to fetch blob: 404'));
      const { container } = render(<Avatar name="Ann Lee" contactPhoto={{ blobId: 'dbcGone' }} />);

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(fetchBlob).toHaveBeenCalledTimes(1);
      // The cache asks again after a second, since the server refuses a
      // download over its concurrency limit outright; then it gives up.
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(fetchBlob).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

      expect(fetchBlob).toHaveBeenCalledTimes(2);
      expect(img(container)).toBeNull();
      expect(container.textContent).toBe('AL');
    });

    it.each([
      [4, 2],
      [8, 4],
    ])('downloads photos %i / 2 = %i at a time for a server with that maxConcurrentRequests', async (limit, atOnce) => {
      const pending: Array<() => void> = [];
      fetchBlob.mockImplementation(() => new Promise<Blob>((resolve) => pending.push(() => resolve(jpeg()))));
      useAuthStore.setState({ client: { fetchBlob, getMaxConcurrentRequests: () => limit } as never });

      render(<>{[0, 1, 2, 3, 4, 5].map((i) => <Avatar key={i} name="Ann" contactPhoto={{ blobId: `dbc${i}` }} />)}</>);
      await act(async () => {});

      expect(fetchBlob).toHaveBeenCalledTimes(atOnce);
      clearContactPhotoCache();
      pending.forEach((resolve) => resolve());
    });

    it('falls back to initials when a downloaded photo does not render', async () => {
      const { container } = render(<Avatar name="Ann Lee" contactPhoto={{ blobId: 'dbcSvg', mediaType: 'image/svg+xml' }} />);
      await waitFor(() => expect(img(container)).not.toBeNull());

      fireEvent.error(img(container)!);

      expect(img(container)).toBeNull();
      expect(container.textContent).toBe('AL');
    });

    it('downloads through the client of the card\'s login in multi-account mode', async () => {
      const otherFetch = vi.fn(async () => jpeg());
      const original = useAuthStore.getState().getClientForAccount;
      useAuthStore.setState({
        getClientForAccount: (id: string) => (id === 'other@host' ? { fetchBlob: otherFetch } as never : undefined),
      });
      try {
        const { container } = render(
          <Avatar name="Ann" contactPhoto={{ blobId: 'dbcAnn', mediaType: 'image/jpeg', localAccountId: 'other@host' }} />,
        );
        await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('blob:photo'));
        expect(otherFetch).toHaveBeenCalledTimes(1);
        expect(fetchBlob).not.toHaveBeenCalled();
      } finally {
        useAuthStore.setState({ getClientForAccount: original });
      }
    });

    it("asks no other server when the card's login has no client, and tries again once it has one", async () => {
      const original = useAuthStore.getState().getClientForAccount;
      const otherFetch = vi.fn(async () => jpeg());
      let connected = false;
      useAuthStore.setState({
        getClientForAccount: (id: string) => (connected && id === 'other@host' ? { fetchBlob: otherFetch } as never : undefined),
      });
      try {
        const { container } = render(
          <Avatar name="Ann Lee" contactPhoto={{ blobId: 'dbcAnn', mediaType: 'image/jpeg', localAccountId: 'other@host' }} />,
        );
        await act(async () => {});
        // The active client belongs to another login, maybe another server.
        expect(fetchBlob).not.toHaveBeenCalled();
        expect(container.textContent).toBe('AL');

        // Nothing was remembered as a failure: once connected, the photo comes.
        connected = true;
        act(() => useAuthStore.setState({ client: { fetchBlob } as never }));
        await waitFor(() => expect(img(container)?.getAttribute('src')).toBe('blob:photo'));
        expect(otherFetch).toHaveBeenCalledTimes(1);
        expect(fetchBlob).not.toHaveBeenCalled();
      } finally {
        useAuthStore.setState({ getClientForAccount: original });
      }
    });

    it('downloads nothing when images are disabled', () => {
      render(<Avatar name="Ann" contactPhoto={{ blobId: 'dbcAnn' }} disableImages />);
      expect(fetchBlob).not.toHaveBeenCalled();
    });
  });

  // #960: a refresh must reach past the browser's two-week cache of the old
  // icon and retry domains whose favicon failed before.
  it('requests the sender favicon again after a refresh', () => {
    useFaviconRefreshStore.setState({ refreshedAt: 0 });
    const { container } = render(<Avatar name="Jan" email="jan@example.cz" />);
    const img = () => container.querySelector('img');
    expect(img()?.getAttribute('src')).toBe('/api/favicon?domain=example.cz');

    fireEvent.error(img()!);
    expect(img()).toBeNull();

    act(() => useFaviconRefreshStore.getState().refresh());
    const stamp = useFaviconRefreshStore.getState().refreshedAt;
    expect(stamp).toBeGreaterThan(0);
    expect(img()?.getAttribute('src')).toBe(`/api/favicon?domain=example.cz&v=${stamp}`);
  });

  // #903: no sender icons, and so no /api/favicon request, while third-party traffic is off.
  it('shows initials instead of the sender favicon in the no-third-party mode', () => {
    useFaviconRefreshStore.setState({ refreshedAt: 0 });
    setNoThirdPartyTraffic(true);
    try {
      const { container } = render(<Avatar name="Jan" email="jan@example.cz" />);
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toBe('JA');
    } finally {
      setNoThirdPartyTraffic(false);
    }
  });

  // #1439: a forged From must not get the real sender's logo or photo.
  describe('sender warning', () => {
    it('shows a shield instead of the favicon and the initials', () => {
      useFaviconRefreshStore.setState({ refreshedAt: 0 });
      const { container } = render(<Avatar name="PayPal" email="billing@paypal.com" senderWarning="Sender check failed" />);
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toBe('');
      expect(container.querySelector('svg')).not.toBeNull();
      expect((container.firstChild as HTMLElement).getAttribute('title')).toBe('PayPal (Sender check failed)');
    });

    it('downloads no contact photo for the claimed sender', () => {
      const fetchBlob = vi.fn();
      useAuthStore.setState({ client: { fetchBlob } as never });
      const { container } = render(<Avatar name="Ann" email="ann@example.com" contactPhoto={{ blobId: 'dbcAnn' }} senderWarning="Unverified sender" />);
      expect(container.querySelector('img')).toBeNull();
      expect(fetchBlob).not.toHaveBeenCalled();
    });

    it('shows the shield, not the brand logo, when both are given', () => {
      const { container } = render(<Avatar name="PayPal" email="billing@paypal.com" senderWarning="Sender check failed" brandDomain="paypal.com" />);
      expect(container.querySelector('img')).toBeNull();
    });
  });

  describe('brand logo (BIMI)', () => {
    beforeEach(() => {
      useFaviconRefreshStore.setState({ refreshedAt: 0 });
      useFaviconRefreshStore.getState().refresh();
      useFaviconRefreshStore.setState({ refreshedAt: 0 });
    });

    it('shows the logo of a domain the message passed DMARC for, before the favicon', () => {
      const { container } = render(<Avatar name="Brand" email="news@brand.org" brandDomain="brand.org" />);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/bimi?domain=brand.org');
    });

    it('asks for no logo without a DMARC pass', () => {
      const { container } = render(<Avatar name="Brand" email="news@brand.org" />);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/favicon?domain=brand.org');
    });

    it('asks for no logo when the avatar shows someone from another domain', () => {
      const { container } = render(<Avatar name="Ann" email="ann@other.org" brandDomain="brand.org" />);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/favicon?domain=other.org');
    });

    it('falls through to the favicon when the domain has no logo', () => {
      const { container } = render(<Avatar name="Brand" email="news@brand.org" brandDomain="brand.org" />);
      const img = container.querySelector('img')!;
      // /api/bimi answers a 1x1 placeholder when there is no logo.
      Object.defineProperty(img, 'naturalWidth', { value: 1 });
      fireEvent.load(img);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/favicon?domain=brand.org');
      // Other avatars of the domain don't ask again.
      const { container: second } = render(<Avatar name="Brand" email="news@brand.org" brandDomain="brand.org" />);
      expect(second.querySelector('img')?.getAttribute('src')).toBe('/api/favicon?domain=brand.org');
    });

    it('keeps a contact photo first', async () => {
      clearContactPhotoCache();
      const fetchBlob = vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }));
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:photo');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      useAuthStore.setState({ client: { fetchBlob } as never });
      try {
        const { container } = render(<Avatar name="Ann" email="ann@brand.org" contactPhoto={{ blobId: 'dbcAnnBrand' }} brandDomain="brand.org" />);
        await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:photo'));
      } finally {
        useAuthStore.setState({ client: null });
        clearContactPhotoCache();
        vi.restoreAllMocks();
      }
    });

    it('asks for no logo while sender icons are off', () => {
      useSettingsStore.setState({ senderFavicons: false });
      try {
        const { container } = render(<Avatar name="Brand" email="news@brand.org" brandDomain="brand.org" />);
        expect(container.querySelector('img')).toBeNull();
      } finally {
        useSettingsStore.setState({ senderFavicons: true });
      }
    });
  });
});
