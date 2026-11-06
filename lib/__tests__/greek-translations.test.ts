// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { createTranslator } from 'next-intl';
import en from '@/locales/en/common.json';
import el from '@/locales/el/common.json';

function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) => leaves(value, prefix ? `${prefix}.${key}` : key));
}

function argumentsOf(message: string): string[] {
  const args = new Set<string>();
  const walk = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      if (element.type !== TYPE.literal && 'value' in element) {
        args.add(`${element.type}:${element.value}`);
      }
      if ('options' in element) {
        for (const option of Object.values(element.options)) walk(option.value);
      }
      if ('children' in element) walk(element.children);
    }
  };
  // A few catalog entries contain literal HTML for raw rendering.
  walk(parse(message, { ignoreTag: true }));
  return [...args].sort();
}

describe('Greek messages', () => {
  const english = new Map(leaves(en));
  const translated = leaves(el).filter(([key, value]) => english.get(key) !== value);

  it('preserves ICU argument names and types in every translated message', () => {
    const failures = translated.flatMap(([key, value]) => {
      try {
        return JSON.stringify(argumentsOf(value)) === JSON.stringify(argumentsOf(english.get(key)!)) ? [] : [key];
      } catch (error) {
        return [`${key}: ${String(error)}`];
      }
    });
    expect(failures).toEqual([]);
  });

  const t = createTranslator({ locale: 'el', messages: el, onError: (error) => { throw error; } });

  it.each([
    [0, '0 μηνύματα'],
    [1, '1 μήνυμα'],
    [2, '2 μηνύματα'],
    [21, '21 μηνύματα'],
  ])('formats %i messages using Greek plural rules', (count, expected) => {
    expect(t('threads.messages_count', { count })).toBe(expected);
  });

  it('formats nested selections and plurals without losing their values', () => {
    expect(t('email_list.pages.position', { more: 'yes', page: 2, pages: 4 })).toBe('Σελίδα 2 από τουλάχιστον 4');
    expect(t('mail_p2_list.conversations_moved_to', { count: 2, mailbox: 'Εργασία' }))
      .toBe('2 συνομιλίες μετακινήθηκαν στον φάκελο Εργασία');
    expect(t('email_composer.files_picker.attach', { count: 0 })).toBe('Επισύναψη');
  });
});
