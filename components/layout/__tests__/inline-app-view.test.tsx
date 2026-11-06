import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InlineAppView } from '../inline-app-view';
import { usePolicyStore } from '@/stores/policy-store';

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

// An app of the operator's policy gets downloads, dialogs and the features
// listed for it; a user's own app keeps the base sandbox (plan: rights per
// admin app, never a user's).
describe('InlineAppView frame rights', () => {
  const initial = usePolicyStore.getState().policy;
  afterEach(() => {
    cleanup();
    usePolicyStore.setState({ policy: initial });
  });

  const base = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';
  const chat = {
    id: 'admin-app-chat', name: 'Chat', url: 'https://chat.example.com/', icon: 'Globe',
    openMode: 'inline' as const, showOnMobile: false, allow: ['clipboard-write', 'camera'],
  };

  it('grants an app of the policy what the operator listed', () => {
    usePolicyStore.setState({ policy: { ...initial, defaultSidebarApps: [chat] as never } });
    render(<InlineAppView apps={[{ id: chat.id, url: chat.url, name: chat.name }]} activeAppId={chat.id} onClose={vi.fn()} />);
    const frame = screen.getByTitle('Chat');
    expect(frame).toHaveAttribute('sandbox', `${base} allow-downloads allow-modals`);
    expect(frame).toHaveAttribute('allow', 'clipboard-write https://chat.example.com; camera https://chat.example.com');
  });

  it('keeps a user\'s own app to the base sandbox', () => {
    usePolicyStore.setState({ policy: { ...initial, defaultSidebarApps: [chat] as never } });
    render(<InlineAppView apps={[{ id: 'mine', url: chat.url, name: 'Mine' }]} activeAppId="mine" onClose={vi.fn()} />);
    const frame = screen.getByTitle('Mine');
    expect(frame).toHaveAttribute('sandbox', base);
    expect(frame).not.toHaveAttribute('allow');
  });
});
