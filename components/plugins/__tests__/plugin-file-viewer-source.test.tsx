// A file a plugin opens in the app's own preview (api.ui.openFile, or a PDF it prints) says which
// plugin opened it, in a line under the file name. The plugin chooses the name; the line is the
// host's, and the name stays on one line, so a long name can't push the line out of view. The
// app's own previews carry no such line.
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
  useLocale: () => 'en',
}));
vi.mock('@/lib/standalone-display', () => ({ canOpenUrlInNewWindow: () => false }));

import { PluginFileViewerHost } from '@/components/plugins/plugin-file-viewer-host';
import { FilePreviewModal } from '@/components/files/file-preview-modal';
import { showPluginFile, currentFileView, closePluginFile } from '@/lib/plugin-sandbox/file-viewer';
import { usePluginStore } from '@/stores/plugin-store';

function install(name: string) {
  usePluginStore.setState({
    plugins: [{ id: 'docs', name, version: '1.0.0', author: '', description: '', type: 'ui-extension', permissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {} } as InstalledPlugin],
  } as never);
}

function open(name: string) {
  act(() => {
    showPluginFile({ pluginId: 'docs', name, blob: new Blob(['%PDF-1.4\n'], { type: 'application/pdf' }), print: false });
  });
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  const view = currentFileView();
  if (view) act(() => closePluginFile(view.id));
  cleanup();
});

describe('a file a plugin opens in the preview', () => {
  it('says which plugin opened it, under the file name', async () => {
    install('Paperless');
    render(<PluginFileViewerHost />);
    open('Security notice from your administrator.pdf');

    const source = await screen.findByText('opened_by_plugin Paperless');
    const line = source.closest('[data-preview-source]')!;
    expect(line).not.toBeNull();
    // Not part of the name the plugin chose.
    const heading = screen.getByRole('heading', { name: 'Security notice from your administrator.pdf' });
    expect(heading.contains(line)).toBe(false);
    // Read out with the preview.
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('opened_by_plugin Paperless');
  });

  it('keeps a long file name on one line, so the line under it stays', async () => {
    install('Paperless');
    render(<PluginFileViewerHost />);
    open(`${'Please confirm your password '.repeat(20)}.pdf`);

    await screen.findByText('opened_by_plugin Paperless');
    expect(screen.getByRole('heading').className).toMatch(/\btruncate\b/);
  });

  it('names the plugin by its id when it is no longer installed', async () => {
    usePluginStore.setState({ plugins: [] } as never);
    render(<PluginFileViewerHost />);
    open('report.pdf');
    expect(await screen.findByText('opened_by_plugin docs')).toBeTruthy();
  });

  // Control: the app's own preview has no such line.
  it('adds nothing to the app\'s own previews', () => {
    render(<FilePreviewModal name="invoice.pdf" onClose={vi.fn()} onDownload={vi.fn()} getFileContent={() => new Promise(() => {})} />);
    expect(document.querySelector('[data-preview-source]')).toBeNull();
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby');
  });
});
