import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canOpenUrlInNewWindow, isStandaloneDisplayMode, openPreviewInNewWindow } from '../standalone-display';

// An installed app (PWA) hands window.open(url, "_blank") to the system
// browser, which cannot resolve the app's blob: URLs, so attachment previews
// opened that way came up blank (#865).

function mockDisplayMode(mode: string | null) {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: mode !== null && query === `(display-mode: ${mode})`,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })));
}

let openSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openSpy = vi.fn(() => null);
  vi.stubGlobal('open', openSpy);
  mockDisplayMode('browser');
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as Navigator & { standalone?: boolean }).standalone;
});

describe('isStandaloneDisplayMode', () => {
  it('is false in a browser tab', () => {
    expect(isStandaloneDisplayMode()).toBe(false);
  });

  it.each(['standalone', 'fullscreen', 'window-controls-overlay'])('is true in %s display mode', (mode) => {
    mockDisplayMode(mode);
    expect(isStandaloneDisplayMode()).toBe(true);
  });

  it('is true for an iOS home-screen app that only reports navigator.standalone', () => {
    mockDisplayMode(null);
    (navigator as Navigator & { standalone?: boolean }).standalone = true;
    expect(isStandaloneDisplayMode()).toBe(true);
  });
});

describe('openPreviewInNewWindow', () => {
  const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

  it('opens a blob: URL in a new window from a browser tab', () => {
    expect(openPreviewInNewWindow('blob:https://mail.example/abc', undefined, png())).toBe(true);
    expect(openSpy).toHaveBeenCalledWith('blob:https://mail.example/abc', '_blank', 'noopener,noreferrer');
  });

  it('does not open a blob: URL in an installed app and tells the caller to preview in-app', () => {
    mockDisplayMode('standalone');
    expect(openPreviewInNewWindow('blob:https://mail.example/abc', undefined, png())).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('does not open a blob: URL in an iOS home-screen app', () => {
    mockDisplayMode(null);
    (navigator as Navigator & { standalone?: boolean }).standalone = true;
    expect(openPreviewInNewWindow('blob:https://mail.example/abc', undefined, png())).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  // A blob: URL opens as a document of the webmail origin: only for a Blob
  // whose type is on the inline-safe list, spelled as the list spells it.
  it.each([
    'image/gif,text/html',
    'image/gif, text/html',
    'audio/mpeg,text/html',
    'image/svg+xml',
    'image/svg+xml,',
    'image/svg+xml x',
    'text/html',
    'application/xhtml+xml',
    'image/png; charset=utf-8',
    'image/jpg',
    '',
  ])('does not open a blob: URL whose Blob is typed %j', (type) => {
    expect(openPreviewInNewWindow('blob:https://mail.example/abc', undefined, new Blob(['x'], { type }))).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('does not open a blob: URL without the Blob it was made from', () => {
    expect(openPreviewInNewWindow('blob:https://mail.example/abc')).toBe(false);
    expect(openPreviewInNewWindow('BLOB:https://mail.example/abc')).toBe(false);
    expect(openPreviewInNewWindow(' blob:https://mail.example/abc')).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it.each(['image/png', 'image/jpeg', 'video/mp4', 'audio/mpeg', 'application/pdf', 'text/plain'])('opens a blob: URL of a Blob typed %j', (type) => {
    expect(openPreviewInNewWindow('blob:https://mail.example/abc', undefined, new Blob(['x'], { type }))).toBe(true);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('still opens a web URL (e.g. a plugin viewer) in an installed app', () => {
    mockDisplayMode('standalone');
    expect(canOpenUrlInNewWindow('https://viewer.example/doc')).toBe(true);
    expect(openPreviewInNewWindow('https://viewer.example/doc')).toBe(true);
    expect(openSpy).toHaveBeenCalledWith('https://viewer.example/doc', '_blank', 'noopener,noreferrer');
  });
});
