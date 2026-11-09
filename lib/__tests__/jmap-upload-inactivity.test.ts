import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestTimeoutError } from '../jmap/client';
import { UploadXHR, uploadClient } from './helpers/upload-xhr';

const INACTIVITY_MS = 300_000;
const file = () => new File(['0123456789'], 'A.txt', { type: 'text/plain' });

async function start(options: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal; accountId?: string } = { onProgress: vi.fn() }) {
  const client = uploadClient();
  const body = file();
  const completed = vi.fn();
  const promise = client.uploadBlob(body, options);
  void promise.then(completed, completed);
  await vi.advanceTimersByTimeAsync(0);
  return { promise, completed, body, xhr: UploadXHR.instances[0] };
}

beforeEach(() => {
  vi.useFakeTimers();
  UploadXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', UploadXHR);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected networking'); }));
});

afterEach(() => {
  for (const xhr of UploadXHR.instances) xhr.abort();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('JMAP XHR upload inactivity recovery', () => {
  it('rejects a silent upload at five minutes, aborts it and does not retry', async () => {
    const { promise, completed, xhr } = await start();
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS - 1);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledExactlyOnceWith(expect.any(RequestTimeoutError));
    await expect(promise).rejects.toThrow('Request timed out after 300s');
    expect(xhr.abort).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS);
    expect(UploadXHR.instances).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets the threshold when additional bytes have transferred', async () => {
    const { completed, xhr } = await start();
    await vi.advanceTimersByTimeAsync(240_000);
    xhr.progress(1);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(completed).not.toHaveBeenCalled();
    xhr.progress(2);
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS - 1);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledExactlyOnceWith(expect.any(RequestTimeoutError));
  });

  it('does not renew for zero, duplicate or decreasing byte counts, or a changed total', async () => {
    const { completed, xhr } = await start();
    await vi.advanceTimersByTimeAsync(100_000);
    xhr.progress(0);
    await vi.advanceTimersByTimeAsync(100_000);
    xhr.progress(2);
    await vi.advanceTimersByTimeAsync(100_000);
    xhr.progress(2, 20);
    await vi.advanceTimersByTimeAsync(100_000);
    xhr.progress(1);
    await vi.advanceTimersByTimeAsync(99_999);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledExactlyOnceWith(expect.any(RequestTimeoutError));
  });

  it('allows a successful sixteen-minute transfer while bytes keep increasing', async () => {
    const progress = vi.fn();
    const { promise, completed, xhr, body } = await start({ onProgress: progress });
    expect(progress).toHaveBeenCalledExactlyOnceWith(0, body.size);
    for (let loaded = 1; loaded <= 4; loaded++) {
      await vi.advanceTimersByTimeAsync(240_000);
      xhr.progress(loaded);
      expect(completed).not.toHaveBeenCalled();
    }
    xhr.load();
    await expect(promise).resolves.toEqual({ blobId: 'blob-A.txt', size: 10, type: 'text/plain' });
    expect(progress).toHaveBeenCalledTimes(5);
    expect(xhr.abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([5, 10])('expires after progress to %i bytes followed by five silent minutes', async loaded => {
    const { completed, xhr } = await start();
    await vi.advanceTimersByTimeAsync(120_000);
    xhr.progress(loaded);
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS - 1);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledExactlyOnceWith(expect.any(RequestTimeoutError));
    expect(xhr.abort).toHaveBeenCalledOnce();
  });

  it('observes byte activity for signal-only callers and keeps the file-size progress fallback', async () => {
    const controller = new AbortController();
    const { promise, completed, xhr } = await start({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(240_000);
    xhr.progress(2, 0, false);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(completed).not.toHaveBeenCalled();
    xhr.load();
    await promise;

    const progress = vi.fn();
    const next = uploadClient().uploadBlob(file(), { onProgress: progress });
    await vi.advanceTimersByTimeAsync(0);
    UploadXHR.instances[1].progress(3, 0, false);
    expect(progress).toHaveBeenLastCalledWith(3, 10);
    UploadXHR.instances[1].load();
    await next;
  });

  it.each(['success', 'http', 'network', 'cancel', 'native abort', 'native timeout', 'invalid JSON'])('cleans the watchdog and signal listener after %s', async terminal => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { promise, completed, xhr } = await start({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(120_000);
    if (terminal === 'success') xhr.load();
    else if (terminal === 'http') xhr.load(503, 'synthetic failure');
    else if (terminal === 'network') xhr.error();
    else if (terminal === 'cancel') controller.abort();
    else if (terminal === 'native abort') xhr.abort();
    else if (terminal === 'native timeout') xhr.timeout();
    else xhr.load(201, 'invalid JSON');
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toHaveBeenCalledOnce();
    if (terminal === 'success') await expect(promise).resolves.toHaveProperty('blobId');
    else if (terminal === 'cancel' || terminal === 'native abort') await expect(promise).rejects.toHaveProperty('name', 'AbortError');
    else if (terminal === 'native timeout') await expect(promise).rejects.toBeInstanceOf(RequestTimeoutError);
    else await expect(promise).rejects.toBeInstanceOf(Error);
    expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS * 2);
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each(['timeout', 'cancel', 'load', 'error'])('%s wins the terminal race; retained late callbacks cannot renew or report', async first => {
    const controller = new AbortController();
    const progress = vi.fn();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { completed, xhr } = await start({ signal: controller.signal, onProgress: progress });
    // Retain callbacks even if cleanup detaches them from the XHR.
    const late = { progress: xhr.upload.onprogress, load: xhr.onload, error: xhr.onerror, abort: xhr.onabort, timeout: xhr.ontimeout };
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS - 1);
    if (first === 'cancel') controller.abort();
    else if (first === 'load') xhr.load();
    else if (first === 'error') xhr.error();
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    if (first === 'timeout') expect(completed).toHaveBeenCalledExactlyOnceWith(expect.any(RequestTimeoutError));
    else if (first === 'cancel') expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'AbortError' }));
    else if (first === 'load') expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ blobId: 'blob-A.txt' }));
    else expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Upload network error' }));
    const progressCalls = progress.mock.calls.length;
    late.progress?.(new ProgressEvent('progress', { loaded: 9, total: 10, lengthComputable: true }));
    late.load?.(); late.error?.(); late.abort?.(); late.timeout?.();
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS * 2);
    expect(completed).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledTimes(progressCalls);
    expect(remove).toHaveBeenCalledOnce();
    expect(xhr.abort).toHaveBeenCalledTimes(first === 'timeout' || first === 'cancel' ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a pre-aborted signal without starting a request or watchdog', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(uploadClient().uploadBlob(file(), { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
    expect(UploadXHR.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles cancellation from the initial progress callback before send', async () => {
    const controller = new AbortController();
    const { promise, completed, xhr } = await start({ signal: controller.signal, onProgress: () => controller.abort() });
    expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'AbortError' }));
    await expect(promise).rejects.toHaveProperty('name', 'AbortError');
    expect(xhr.body).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up a synchronous send failure', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    vi.spyOn(UploadXHR.prototype, 'send').mockImplementationOnce(() => { throw new Error('synthetic send failure'); });
    const { promise } = await start({ signal: controller.signal });
    await expect(promise).rejects.toThrow('synthetic send failure');
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves request construction and nested upload results', async () => {
    const { promise, xhr, body } = await start({ accountId: 'group/a b', onProgress: vi.fn() });
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('https://upload.invalid/upload/group%2Fa%20b');
    expect(xhr.headers).toEqual({ 'Content-Type': 'text/plain', Authorization: uploadClient().getAuthHeader() });
    expect(xhr.body).toBe(body);
    expect(xhr.responseType).toBe('text');
    xhr.load(200, JSON.stringify({ 'group/a b': { blobId: 'nested', size: 10, type: 'text/plain' } }));
    await expect(promise).resolves.toEqual({ blobId: 'nested', size: 10, type: 'text/plain' });
  });
});
