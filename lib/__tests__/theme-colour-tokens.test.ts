import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// A colour token in globals.css only becomes a Tailwind utility (bg-note,
// text-note-foreground, ...) once app/theme-inline.css maps it. Without the
// mapping the class silently does nothing, as the team note cards once had
// no background at all.

const root = path.resolve(__dirname, '../..');
const globals = readFileSync(path.join(root, 'app/globals.css'), 'utf8');
const inline = readFileSync(path.join(root, 'app/theme-inline.css'), 'utf8');

describe('theme colour tokens', () => {
  it('maps the team note colours to Tailwind utilities, light and dark', () => {
    for (const name of ['note', 'note-foreground', 'note-border']) {
      expect(globals.match(new RegExp(`--color-${name}:`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(inline).toContain(`--color-${name}: var(--color-${name});`);
    }
  });
});
