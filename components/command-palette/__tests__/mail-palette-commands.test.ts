import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Mail registers its palette commands in mail-app.tsx, which is too big to render
// here. Each message action with a key in the shortcuts help is in the palette too,
// under the key the help names.
const source = readFileSync(path.join(process.cwd(), 'components/mail/mail-app.tsx'), 'utf8');
const block = source.slice(source.indexOf("useRegisterCommands(t('sidebar.mail')"));

describe('Mail commands in the palette', () => {
  it.each([
    ['reply', 'r'],
    ['reply-all', 'a'],
    ['forward', 'f'],
    ['star', 's'],
    ['archive', 'e'],
    ['delete', '#'],
    ['mark-unread', 'u'],
    ['mark-read', 'Shift + I'],
    ['spam', '!'],
  ])('has %s, shown with %s', (id, key) => {
    const at = block.indexOf(`id: '${id}'`);
    expect(at).toBeGreaterThan(-1);
    const entry = block.slice(at, block.indexOf('}', at));
    expect(entry).toContain(`shortcut: '${key}'`);
  });
});
