import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import { FilePreviewModal } from '../file-preview-modal';

// The image preview used a plain object URL of the attachment, and those share
// the webmail origin. "Open image in new tab" on a sender's SVG (or on HTML
// declared on an .svg name) then loaded it as a same-origin document.

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>';

let created: Blob[];

beforeEach(() => {
  created = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    created.push(blob as Blob);
    return 'blob:test';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function previewSrc(name: string, contentType: string, bytes: BlobPart): Promise<string> {
  render(
    <FilePreviewModal
      name={name}
      onClose={() => {}}
      onDownload={() => {}}
      getFileContent={async () => ({ blob: new Blob([bytes], { type: contentType }), contentType })}
    />,
  );
  return (await screen.findByAltText(name)).getAttribute('src') ?? '';
}

describe('FilePreviewModal image URLs', () => {
  it('shows an SVG from a data: URL, never a same-origin object URL', async () => {
    const src = await previewSrc('drawing.svg', 'image/svg+xml', SVG);
    expect(src.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(created).toEqual([]);
    expect(screen.queryByLabelText('open_in_new_tab')).toBeNull();
  });

  it('retypes HTML declared on an image name to something no browser runs', async () => {
    expect(await previewSrc('drawing.svg', 'text/html', '<script>alert(1)</script>')).toBe('blob:test');
    expect(created.map((b) => b.type)).toEqual(['application/octet-stream']);
  });

  it('keeps raster images as object URLs of their own type', async () => {
    expect(await previewSrc('photo.png', 'image/png', new Uint8Array([137, 80, 78, 71]))).toBe('blob:test');
    expect(created.map((b) => b.type)).toEqual(['image/png']);
    expect(screen.getByLabelText('open_in_new_tab')).toBeTruthy();
  });
});
