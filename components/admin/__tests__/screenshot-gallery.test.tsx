import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScreenshotGallery } from '../screenshot-gallery';

const images = [
  { url: 'https://dir.example/1.webp', altText: 'The agenda in the sidebar' },
  { url: 'https://dir.example/2.webp', altText: null },
  { url: 'https://dir.example/3.webp', altText: null },
];

const large = () => screen.getByTestId('screenshot-gallery-dialog').querySelector('img')!;

describe('ScreenshotGallery', () => {
  it('opens the clicked screenshot large', () => {
    render(<ScreenshotGallery images={images} name="Agenda" />);
    expect(screen.queryByTestId('screenshot-gallery-dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Agenda screenshot 2 larger' }));
    expect(large().getAttribute('src')).toBe('https://dir.example/2.webp');
    expect(screen.getByText('Screenshot 2 of 3')).toBeTruthy();
  });

  it('steps with the buttons and the arrow keys, wrapping at the ends', () => {
    render(<ScreenshotGallery images={images} name="Agenda" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open The agenda in the sidebar larger' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous screenshot' }));
    expect(large().getAttribute('src')).toBe('https://dir.example/3.webp');
    fireEvent.keyDown(large(), { key: 'ArrowRight' });
    expect(large().getAttribute('src')).toBe('https://dir.example/1.webp');
    fireEvent.click(screen.getByRole('button', { name: 'Next screenshot' }));
    expect(large().getAttribute('src')).toBe('https://dir.example/2.webp');
  });

  it('has no stepping for a single screenshot', () => {
    render(<ScreenshotGallery images={images.slice(0, 1)} name="Agenda" />);
    fireEvent.click(screen.getByRole('button', { name: /larger/ }));
    expect(screen.queryByRole('button', { name: 'Next screenshot' })).toBeNull();
    expect(screen.getByText('Screenshot')).toBeTruthy();
  });
});
