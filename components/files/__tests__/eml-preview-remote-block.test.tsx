import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import { EmlPreview } from '../eml-preview';
import { useSettingsStore } from '@/stores/settings-store';

// The .eml attachment preview sanitized the body but never blocked remote
// content and set no CSP, so opening an attached message fired its trackers
// whatever the user's remote-content policy said.

const HTML = '<p>x</p><img src="https://t.example/pixel.gif"><img srcset="https://t.example/srcset.gif 1x">';

function srcdoc(): string {
  const { container } = render(
    <EmlPreview message={{ subject: 's', html: HTML, attachments: [] }} />,
  );
  return container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
}

afterEach(() => {
  useSettingsStore.setState({ externalContentPolicy: 'ask' });
});

describe('EmlPreview remote content', () => {
  it('blocks remote images and sets the strict CSP by default', () => {
    const doc = srcdoc();
    expect(doc).not.toMatch(/\s(src|srcset)="https:\/\/t\.example/);
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1] ?? '';
    expect(csp).toContain("img-src data: blob:;");
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('loads them when the user allows remote content everywhere', () => {
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    expect(srcdoc()).toContain('src="https://t.example/pixel.gif"');
  });
});
