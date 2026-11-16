// On an iPhone or iPad, a blob: download opens in a preview window. A file
// iOS cannot preview there (a "Download all" zip, an unknown type) came up as
// a blank page with nothing to tap, so saveBlobAs() hands such a file to the
// share sheet instead; everything else, and every other platform, keeps the
// <a download>.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SHARE_NEEDS_TAP_EVENT, iosCanPreview, isAppleMobile, saveBlobAs, setDownloadGuard } from '../download-guard';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
};

function setNavigator(fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(window.navigator, key, { value, configurable: true, writable: true });
  }
}

const iphone = () => setNavigator({ userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5 });
const zip = () => new Blob(['PK'], { type: 'application/zip' });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('isAppleMobile and iosCanPreview', () => {
  it('knows an iPhone, Chrome on an iPhone, and an iPad asking for desktop sites', () => {
    expect(isAppleMobile({ userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5 })).toBe(true);
    expect(isAppleMobile({ userAgent: UA.iosChrome, platform: 'iPhone', maxTouchPoints: 5 })).toBe(true);
    expect(isAppleMobile({ userAgent: UA.mac, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isAppleMobile({ userAgent: UA.mac, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(isAppleMobile({ userAgent: UA.android, platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(false);
  });

  it('previews PDF, pictures and Office files, not archives or unknown types', () => {
    expect(iosCanPreview('a.pdf', 'application/octet-stream')).toBe(true);
    expect(iosCanPreview('scan', 'image/jpeg')).toBe(true);
    expect(iosCanPreview('report.DOCX', '')).toBe(true);
    expect(iosCanPreview('Attachments.zip', 'application/zip')).toBe(false);
    expect(iosCanPreview('backup.7z', 'application/octet-stream')).toBe(false);
    expect(iosCanPreview('page.html', 'text/html')).toBe(false);
  });
});

describe('saveBlobAs on an iPhone', () => {
  let clicked: string[];
  let share: ReturnType<typeof vi.fn>;
  let canShare: ReturnType<typeof vi.fn>;
  let tapAsked: File[];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const onTap = (event: Event) => { tapAsked.push((event as CustomEvent<{ file: File }>).detail.file); };

  beforeEach(() => {
    clicked = [];
    tapAsked = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
    share = vi.fn(async () => {});
    canShare = vi.fn(() => true);
    setNavigator({ share, canShare });
    window.addEventListener(SHARE_NEEDS_TAP_EVENT, onTap);
  });

  afterEach(() => {
    window.removeEventListener(SHARE_NEEDS_TAP_EVENT, onTap);
    setDownloadGuard(null);
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  it('hands a zip to the share sheet, with its name and type', () => {
    iphone();
    expect(saveBlobAs(zip(), 'Attachments.zip', { kind: 'attachment' })).toBe(true);
    expect(clicked).toEqual([]);
    expect(share).toHaveBeenCalledTimes(1);
    const file = (share.mock.calls[0][0] as { files: File[] }).files[0];
    expect(file.name).toBe('Attachments.zip');
    expect(file.type).toBe('application/zip');
  });

  it('keeps the <a download> for a PDF', () => {
    iphone();
    saveBlobAs(new Blob(['%PDF'], { type: 'application/pdf' }), 'Invoice.pdf', { kind: 'attachment' });
    expect(clicked).toEqual(['Invoice.pdf']);
    expect(share).not.toHaveBeenCalled();
  });

  it('keeps the <a download> on a desktop and on Android', () => {
    setNavigator({ userAgent: UA.mac, platform: 'MacIntel', maxTouchPoints: 0 });
    saveBlobAs(zip(), 'Attachments.zip', { kind: 'attachment' });
    setNavigator({ userAgent: UA.android, platform: 'Linux armv8l', maxTouchPoints: 5 });
    saveBlobAs(zip(), 'Attachments.zip', { kind: 'attachment' });
    expect(clicked).toEqual(['Attachments.zip', 'Attachments.zip']);
    expect(share).not.toHaveBeenCalled();
  });

  it('asks the app for a tap when the click is too old for the sheet', async () => {
    iphone();
    share.mockRejectedValueOnce(Object.assign(new Error('no activation'), { name: 'NotAllowedError' }));
    saveBlobAs(zip(), 'Attachments.zip', { kind: 'attachment' });
    await flush();
    expect(tapAsked.map((f) => f.name)).toEqual(['Attachments.zip']);
    expect(clicked).toEqual([]);
  });

  it('does nothing more when the sheet is closed', async () => {
    iphone();
    share.mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'AbortError' }));
    saveBlobAs(zip(), 'Attachments.zip', { kind: 'attachment' });
    await flush();
    expect(tapAsked).toEqual([]);
    expect(clicked).toEqual([]);
  });

  it('falls back to the <a download> when the sheet cannot take the file', () => {
    iphone();
    canShare.mockReturnValue(false);
    saveBlobAs(zip(), 'Attachments.zip', { kind: 'attachment' });
    expect(clicked).toEqual(['Attachments.zip']);
    expect(share).not.toHaveBeenCalled();
  });

  it('shares nothing a device policy forbids', () => {
    iphone();
    setDownloadGuard(() => false);
    expect(saveBlobAs(zip(), 'Attachments.zip', { kind: 'attachment' })).toBe(false);
    expect(share).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
  });
});
