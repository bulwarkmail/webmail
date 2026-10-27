import { describe, expect, it } from 'vitest';
import { downloadNameSegment } from '../download-name';

describe('downloadNameSegment', () => {
  it.each([
    ['banner.jpg', 'banner.jpg'],
    ['/images/banner.jpg', 'banner.jpg'],
    ['C:\\Users\\me\\report.pdf', 'report.pdf'],
    ['100% done.txt', '100% done.txt'],
  ])('turns %j into %j', (name, expected) => {
    expect(downloadNameSegment(name)).toBe(expected);
  });

  it.each([undefined, '', '   ', '/images/', '\\'])('falls back to "download" for %j', (name) => {
    expect(downloadNameSegment(name)).toBe('download');
  });
});
