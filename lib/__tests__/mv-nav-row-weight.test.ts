import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Mountain View's folder rows used bold for two things: the open folder and a
 * folder with unread mail. A selected folder without unread mail then looked
 * exactly like an unread one (#1469). Bold now means unread only; the pill
 * marks the open folder.
 *
 * jsdom does not resolve the cascade of these attribute rules, so lock the
 * stylesheet rules themselves.
 */
const css = readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf8');

const NAV_ROW = '[data-interface-layout="mountain-view"] [data-mv-nav-row]';

/** The declaration block of the rule with exactly this selector. */
function ruleBody(selector: string): { body: string; index: number } {
  const index = css.indexOf(`${selector} {`);
  expect(index, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', index);
  return { body: css.slice(open + 1, css.indexOf('}', open)), index };
}

const weightOf = (body: string) => body.match(/font-weight:\s*(\d+)/)?.[1];

describe('Mountain View folder row weight (#1469)', () => {
  it('does not bold the open folder', () => {
    // Set explicitly: without it the row's own `font-semibold` for the
    // selected state would still apply.
    const weight = weightOf(ruleBody(`${NAV_ROW}[data-selected="true"]`).body);
    expect(weight).toBeDefined();
    expect(Number(weight)).toBeLessThanOrEqual(400);
  });

  it('still bolds a folder with unread mail, also when it is open', () => {
    const selected = ruleBody(`${NAV_ROW}[data-selected="true"]`);
    const unread = ruleBody(`${NAV_ROW}[data-has-unread]`);
    expect(Number(weightOf(unread.body))).toBeGreaterThanOrEqual(700);
    // Same specificity, so the unread rule has to come later to win on a
    // selected folder that has unread mail.
    expect(unread.index).toBeGreaterThan(selected.index);
  });
});
