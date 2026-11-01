import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { TARGET_NAMES } from '@/lib/connector/registry';
import { CONNECTOR_SURFACES } from '@/lib/boot-skeleton/surfaces';

// A connector link that can't be opened explains why in the reader's
// language (keys in tests), not in English only.

vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Bulwark' }) }));
vi.mock('@/lib/browser-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/browser-navigation')>()),
  replaceWindowLocation: vi.fn(),
}));

const { ConnectorClient } = await import('../connector-client');

describe('connector link page', () => {
  it('translates an unknown link', async () => {
    render(<ConnectorClient target="no-such-target" />);
    expect(await screen.findByRole('heading', { name: /unknown_title/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open_app/ })).toBeInTheDocument();
    expect(screen.queryByText(/newer than this/)).toBeNull();
  });

  it('translates a link with a broken parameter', async () => {
    window.history.replaceState(null, '', '/connector/calendar?view=nope');
    render(<ConnectorClient target="calendar" />);
    expect(await screen.findByRole('heading', { name: /malformed_title/ })).toBeInTheDocument();
    window.history.replaceState(null, '', '/');
  });
});

describe('connector link page while it resolves', () => {
  // The server HTML is what shows until the redirect: the skeleton of the
  // page the link opens, with the opening text as its status message.
  it.each(TARGET_NAMES)('%s draws its destination skeleton', (target) => {
    const html = renderToString(<ConnectorClient target={target} />);
    const surface = CONNECTOR_SURFACES[target];
    expect(html).toContain(`data-boot-skeleton="${surface}"`);
    expect(html).toContain('role="status"');
    expect(html).toContain('opening');
  });

  it('keeps the plain text for a target it does not know', () => {
    const html = renderToString(<ConnectorClient target="constructor" />);
    expect(html).not.toContain('data-boot-skeleton');
    expect(html).toContain('opening');
  });
});
