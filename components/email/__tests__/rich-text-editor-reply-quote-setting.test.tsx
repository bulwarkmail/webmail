import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';

import { RichTextEditor } from '../rich-text-editor';
import { useSettingsStore } from '@/stores/settings-store';

// "Quoted text in replies" in Settings > Composing (#1800): a reply opens with
// the quoted messages folded behind ••• or shown in full.

const REPLY = '<p></p><p data-reply-quote-start="true">On Tuesday, C wrote:</p><div data-quoted-html=""><p>Original text</p></div>';

function openReply() {
  const view = render(<RichTextEditor content={REPLY} onChange={() => {}} />);
  return view.container;
}

afterEach(() => {
  useSettingsStore.setState({ replyQuoteDisplay: 'collapsed' });
});

describe('quoted text in replies', () => {
  it('starts folded by default', async () => {
    const container = openReply();
    const toggle = await waitFor(() => {
      const button = container.querySelector('[data-reply-quote-toggle]');
      expect(button).not.toBeNull();
      return button!;
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('[data-reply-quote-collapsed]')).not.toBeNull();
  });

  it('starts shown in full when the setting is Expanded', async () => {
    useSettingsStore.setState({ replyQuoteDisplay: 'expanded' });
    const container = openReply();
    const toggle = await waitFor(() => {
      const button = container.querySelector('[data-reply-quote-toggle]');
      expect(button).not.toBeNull();
      return button!;
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('[data-reply-quote-collapsed]')).toBeNull();
  });
});
