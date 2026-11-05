import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { InlineAppView } from '../inline-app-view';

// Until an app's frame has loaded it holds the initial about:blank, which a dark
// theme turns into an opaque white canvas in WebKit (#1517). Each frame stays
// invisible until its own first load, and stays visible after that.

const apps = [
  { id: 'a', url: 'https://a.example.com/', name: 'App A' },
  { id: 'b', url: 'https://b.example.com/', name: 'App B' },
];

describe('InlineAppView', () => {
  it('keeps a frame invisible until it has loaded', () => {
    render(<InlineAppView apps={apps.slice(0, 1)} activeAppId="a" onClose={vi.fn()} />);
    const frame = screen.getByTitle('App A');
    expect(frame).toHaveClass('invisible');
    fireEvent.load(frame);
    expect(frame).not.toHaveClass('invisible');
  });

  it('waits for each app on its own', () => {
    const { rerender } = render(<InlineAppView apps={apps} activeAppId="a" onClose={vi.fn()} />);
    fireEvent.load(screen.getByTitle('App A'));
    rerender(<InlineAppView apps={apps} activeAppId="b" onClose={vi.fn()} />);
    expect(screen.getByTitle('App B')).toHaveClass('invisible');
    expect(screen.getByTitle('App A')).toHaveClass('hidden');
    expect(screen.getByTitle('App A')).not.toHaveClass('invisible');
  });

  it('shows a loaded app again at once when it comes back', () => {
    const { rerender } = render(<InlineAppView apps={apps} activeAppId="a" onClose={vi.fn()} />);
    fireEvent.load(screen.getByTitle('App A'));
    rerender(<InlineAppView apps={apps} activeAppId="b" onClose={vi.fn()} />);
    fireEvent.load(screen.getByTitle('App B'));
    rerender(<InlineAppView apps={apps} activeAppId="a" onClose={vi.fn()} />);
    const frame = screen.getByTitle('App A');
    expect(frame).not.toHaveClass('hidden');
    expect(frame).not.toHaveClass('invisible');
  });
});
