import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { PaneIdContext, ProTabFocusContext } from '@/hooks/use-pane-context';

// Pro keeps every open tab mounted, and each surface added its print copy when
// printing started: an open Calendar tab came along with a printed message.

vi.mock('@/components/device/watermark', () => ({ Watermark: () => null, useWatermarkText: () => '' }));

import { PrintRoot } from '../print-root';

const roots = () => document.querySelectorAll('[data-print-root]').length;

function copyInTab(focused: boolean) {
  return (
    <PaneIdContext.Provider value="main">
      <ProTabFocusContext.Provider value={focused}>
        <PrintRoot orientation="portrait" title="Copy title">copy</PrintRoot>
      </ProTabFocusContext.Provider>
    </PaneIdContext.Provider>
  );
}

describe('PrintRoot', () => {
  afterEach(() => {
    document.title = '';
  });

  it('draws its copy in the standard shell', () => {
    render(<PrintRoot orientation="portrait">copy</PrintRoot>);
    expect(roots()).toBe(1);
  });

  it('draws it for the Pro tab in front', () => {
    render(copyInTab(true));
    expect(roots()).toBe(1);
    expect(document.title).toBe('Copy title');
  });

  it('draws nothing for a Pro tab behind it, and leaves the title alone', () => {
    document.title = 'Mail';
    render(copyInTab(false));
    expect(roots()).toBe(0);
    expect(document.title).toBe('Mail');
  });
});
