import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// /api/wopi/status needs the sign-in context cookie. The mail and files views
// can mount before it exists, so a 401 there says nothing about the editor and
// must not leave office editing off until the next page load (#1518).

const ENABLED = { enabled: true, editExtensions: ['docx', 'odt'], viewExtensions: ['pdf'], newExtensions: ['docx'] };

const answer = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<unknown>>;
let useWopiStatus: typeof import('@/hooks/use-wopi-status').useWopiStatus;
let useAuthStore: typeof import('@/stores/auth-store').useAuthStore;

const signIn = (client: object) => useAuthStore.setState({ isAuthenticated: true, client: client as never });

beforeEach(async () => {
  fetchMock = vi.fn();
  // Only the status route counts: the auth store asks for other things on import.
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => (
    url.includes('/api/wopi/status') ? fetchMock(url, init) : Promise.resolve(answer(404))
  ));
  // The hook shares its answer through module state, like a page load does.
  vi.resetModules();
  ({ useWopiStatus } = await import('@/hooks/use-wopi-status'));
  ({ useAuthStore } = await import('@/stores/auth-store'));
  useAuthStore.setState({ isAuthenticated: false, client: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useWopiStatus', () => {
  it('asks nothing before sign-in, and asks once sign-in is done', async () => {
    fetchMock.mockResolvedValue(answer(200, ENABLED));
    const { result } = renderHook(() => useWopiStatus(true));

    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    signIn({});
    await waitFor(() => expect(result.current?.enabled).toBe(true));
    expect(result.current?.editExtensions).toContain('docx');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks nothing while the persisted flag says signed in but no client is connected yet', async () => {
    fetchMock.mockResolvedValue(answer(200, ENABLED));
    useAuthStore.setState({ isAuthenticated: true, client: null });
    renderHook(() => useWopiStatus(true));

    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns editing on when a 401 is followed by the real client taking over', async () => {
    // A local copy is on screen before the restore writes the context cookie.
    fetchMock.mockResolvedValueOnce(answer(401)).mockResolvedValue(answer(200, ENABLED));
    signIn({ kind: 'local copy' });
    const { result } = renderHook(() => useWopiStatus(true));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.enabled).toBe(false);

    signIn({ kind: 'real' });
    await waitFor(() => expect(result.current?.enabled).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not share a 401 still in flight with the client that took over', async () => {
    let finishFirst: (value: unknown) => void = () => {};
    fetchMock
      .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(answer(200, ENABLED));
    signIn({ kind: 'local copy' });
    const { result } = renderHook(() => useWopiStatus(true));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    signIn({ kind: 'real' });
    await waitFor(() => expect(result.current?.enabled).toBe(true));
    finishFirst(answer(401));

    // The late refusal does not take the answer back, for this view or the next.
    await new Promise((resolve) => setTimeout(resolve));
    expect(result.current?.enabled).toBe(true);
    const next = renderHook(() => useWopiStatus(true));
    await waitFor(() => expect(next.result.current?.enabled).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 500, 502])('asks again on the next mount after a %i', async (status) => {
    fetchMock.mockResolvedValueOnce(answer(status)).mockResolvedValue(answer(200, ENABLED));
    signIn({});
    const first = renderHook(() => useWopiStatus(true));
    await waitFor(() => expect(first.result.current).not.toBeNull());
    expect(first.result.current?.enabled).toBe(false);

    const second = renderHook(() => useWopiStatus(true));
    await waitFor(() => expect(second.result.current?.enabled).toBe(true));
  });

  it('keeps a real answer for the page, across views and account switches', async () => {
    fetchMock.mockResolvedValue(answer(200, ENABLED));
    signIn({ account: 'a' });
    const first = renderHook(() => useWopiStatus(true));
    await waitFor(() => expect(first.result.current?.enabled).toBe(true));

    const second = renderHook(() => useWopiStatus(true));
    await waitFor(() => expect(second.result.current?.enabled).toBe(true));
    signIn({ account: 'b' });
    await waitFor(() => expect(useAuthStore.getState().client).toEqual({ account: 'b' }));
    await new Promise((resolve) => setTimeout(resolve));

    expect(first.result.current?.enabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a real "no editor" answer too, so mail views do not keep asking', async () => {
    fetchMock.mockResolvedValue(answer(200, { enabled: false }));
    signIn({});
    const first = renderHook(() => useWopiStatus(true));
    await waitFor(() => expect(first.result.current?.enabled).toBe(false));

    const second = renderHook(() => useWopiStatus(true));
    await waitFor(() => expect(second.result.current?.enabled).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks nothing while the caller has it switched off', async () => {
    fetchMock.mockResolvedValue(answer(200, ENABLED));
    signIn({});
    const { result } = renderHook(() => useWopiStatus(false));

    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});
