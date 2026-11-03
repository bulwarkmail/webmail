import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shellLabels } from '../languages';
import { updateLabels } from '../update-labels';

const en = JSON.parse(readFileSync(path.join(process.cwd(), 'locales/en/common.json'), 'utf8')).desktop_updates as Record<string, string>;

describe('the updater text the shell gets', () => {
  it('keeps the placeholders the shell fills in itself', () => {
    const labels = updateLabels((key, values) => {
      const text = en[key.replace('desktop_updates.', '')];
      return Object.entries(values ?? {}).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, value), text);
    });
    expect(labels.menuUpdateAvailable).toBe('Bulwark {version} is available');
    expect(labels.updateOlderDetail).toContain('{current}');
    expect(labels.updateOlderDetail).toContain('{target}');
    expect(Object.values(labels).every((text) => typeof text === 'string' && text.length > 0)).toBe(true);
  });

  it('goes out with the labels of the menus', () => {
    const labels = shellLabels((key) => key);
    expect(labels.menuRestartToUpdate).toBe('desktop_updates.shell_restart');
    expect(labels.updateReadyTitle).toBe('desktop_updates.shell_ready_title');
    expect(labels.menuFile).toBe('desktopUi.menu.file');
  });
});
