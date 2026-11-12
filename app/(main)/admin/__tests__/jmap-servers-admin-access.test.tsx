import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { JmapServersSection } from '../_pages/_jmap-servers-section';
import type { JmapServerEntry } from '@/lib/admin/jmap-servers';

// Each entry of the admin's server list has a switch for whether its
// superusers may open the admin dashboard without the admin password. It is
// off unless the admin turns it on, and its text is in every language.

describe('the admin access switch in the server list', () => {
  const servers: JmapServerEntry[] = [
    { id: 'own', label: 'Own', url: 'https://mail.example.org', adminAccess: true },
    { id: 'partner', label: 'Partner', url: 'https://partner.example' },
  ];

  it('shows each entry\'s setting and saves a change', () => {
    const onChange = vi.fn();
    render(<JmapServersSection value={servers} onChange={onChange} onRevert={vi.fn()} />);
    const own = screen.getByTestId('jmap-server-admin-access-0');
    const partner = screen.getByTestId('jmap-server-admin-access-1');
    expect(own).toHaveAttribute('aria-checked', 'true');
    expect(partner).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(partner);
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'own', adminAccess: true }),
      expect.objectContaining({ id: 'partner', adminAccess: true }),
    ]);

    fireEvent.click(own);
    const [last] = onChange.mock.calls.at(-1) as [JmapServerEntry[]];
    expect(last[0]).not.toHaveProperty('adminAccess');
    expect(last[1].adminAccess).toBe(true);
  });

  it('is off for a new entry', () => {
    const onChange = vi.fn();
    render(<JmapServersSection value={[]} onChange={onChange} onRevert={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /add server/i }));
    fireEvent.change(screen.getByPlaceholderText('main'), { target: { value: 'new' } });
    fireEvent.change(screen.getByPlaceholderText('https://mail.example.com'), { target: { value: 'https://new.example' } });
    expect(screen.getByTestId('jmap-server-admin-access-0')).toHaveAttribute('aria-checked', 'false');
    expect(onChange.mock.calls.at(-1)?.[0][0]).not.toHaveProperty('adminAccess');
  });

  it('has its label and help in every language', () => {
    const dir = path.join(process.cwd(), 'locales');
    const english = JSON.parse(readFileSync(path.join(dir, 'en', 'common.json'), 'utf-8')).admin_access;
    for (const lang of readdirSync(dir)) {
      const text = JSON.parse(readFileSync(path.join(dir, lang, 'common.json'), 'utf-8')).admin_access;
      expect(Object.keys(text ?? {}), lang).toEqual(['label', 'help']);
      expect(text.label.trim().length, lang).toBeGreaterThan(10);
      expect(text.help.trim().length, lang).toBeGreaterThan(30);
      if (lang !== 'en') expect(text.help, lang).not.toBe(english.help);
    }
  });
});
