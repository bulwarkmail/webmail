import { describe, it, expect } from 'vitest';
import en from '@/locales/en/common.json';
import de from '@/locales/de/common.json';
import {
  type SettingsSearchTab,
  matchesAllWords,
  settingsSubResults,
  subResultText,
  tabSearchEntries,
} from '../settings-search';

// settings-p2-3: "identity", "alias", "sender" and "from address" found
// nothing, and "signature" led to a row that only linked elsewhere. The
// signatures now sit on Composing, and these words find them.
const everywhere = (messages: unknown, query: string) => (Object.keys(tabSearchEntries) as SettingsSearchTab[]).flatMap((tab) =>
  settingsSubResults(messages, tab, 'Bulwark')
    .filter((r) => matchesAllWords(subResultText(r), query))
    .map((r) => `${tab}: ${r.label}`));

describe('settings search: addresses and your name', () => {
  it('finds the sending addresses on Account for identity and alias', () => {
    for (const query of ['identity', 'alias', 'sender address']) {
      expect(everywhere(en, query), query).toContain('account: Email addresses');
    }
  });

  it('finds "Your name" for display name', () => {
    expect(everywhere(en, 'display name')).toContain('account: Your name');
  });

  it('finds them in German too', () => {
    expect(everywhere(de, 'Identität')).toContain('account: E-Mail-Adressen');
  });
});
