import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { getContactPhotoClient, useContactPhotoSrc } from '../use-contact-photo';
import { useAuthStore } from '@/stores/auth-store';
import type { ContactPhotoRef } from '@/stores/contact-store';

/** An avatar-like element on the hook's observe callback; counts its renders. */
function renders(photo: ContactPhotoRef | null): number {
  let count = 0;
  function Probe() {
    count += 1;
    const { observe } = useContactPhotoSrc(photo);
    return createElement('div', { ref: observe });
  }
  render(createElement(Probe));
  return count;
}

describe('useContactPhotoSrc', () => {
  it('draws an avatar with no photo to download once, not again when its element mounts', () => {
    expect(renders(null)).toBe(1);
    expect(renders({ uri: 'https://example.org/a.png' } as ContactPhotoRef)).toBe(1);
  });

  it('takes the element of a photo still to download, to watch it come on screen', () => {
    const blob = { blobId: 'b1', accountId: 'a', localAccountId: 'login', mediaType: 'image/png' } as ContactPhotoRef;
    expect(renders(blob)).toBeGreaterThan(1);
  });
});

describe('getContactPhotoClient', () => {
  const active = { name: 'active' } as never;
  const other = { name: 'other' } as never;
  const original = useAuthStore.getState().getClientForAccount;

  afterEach(() => {
    useAuthStore.setState({ client: null, getClientForAccount: original });
  });

  it('uses the active client for a card without a login (single account)', () => {
    useAuthStore.setState({ client: active });
    expect(getContactPhotoClient(undefined)).toBe(active);
  });

  it("uses the client of the card's login in multi-account mode", () => {
    useAuthStore.setState({
      client: active,
      getClientForAccount: (id: string) => (id === 'other@host' ? other : undefined),
    });
    expect(getContactPhotoClient('other@host')).toBe(other);
  });

  it("is null, not the active client, when the card's login has no client", () => {
    // The active client may talk to another server: the download would fail
    // there and the photo stay blank as a remembered failure.
    useAuthStore.setState({ client: active, getClientForAccount: () => undefined });
    expect(getContactPhotoClient('gone@host')).toBeNull();
  });
});
