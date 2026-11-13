import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore, migrateSettings, migrateAttachmentKeywordsDefault } from '../settings-store';

// #1672: common German phrasings ("in der Anlage", "beigefügt", ...) didn't
// trigger the attachment reminder.

const defaults = () => useSettingsStore.getState().attachmentReminderKeywords;
// As the composer and the quick reply match: the word anywhere in the text.
const reminds = (text: string) => defaults().some((kw) => text.toLowerCase().includes(kw.toLowerCase()));
const before1672 = () =>
  defaults().filter((kw) => !['beigefügt', 'beiliegend', 'angefügt', 'in der anlage', 'als anlage'].includes(kw));

describe('German words for the attachment reminder (#1672)', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  it.each([
    'In der Anlage finden Sie das Angebot.',
    'Die Rechnung habe ich als Anlage mitgeschickt.',
    'Beigefügt erhalten Sie den Vertrag.',
    'Die beigefügten Unterlagen bitte prüfen.',
    'Beiliegend die Präsentation von gestern.',
    'Ich habe das Protokoll angefügt.',
  ])('reminds on "%s"', (text) => {
    expect(reminds(text)).toBe(true);
  });

  it.each([
    'Ich überlege eine Geldanlage in Fonds.',
    'Die Solaranlage läuft seit Montag.',
    'Wir leihen uns einen Anhänger für den Umzug.',
  ])('stays quiet on "%s"', (text) => {
    expect(reminds(text)).toBe(false);
  });

  it('gives a user who kept the old built-in list the new one', () => {
    const state: Record<string, unknown> = { attachmentReminderKeywords: before1672(), explicitSettings: [] };
    migrateAttachmentKeywordsDefault(state);
    expect(state.attachmentReminderKeywords).toEqual(defaults());
  });

  it('keeps a list the user changed', () => {
    const own = [...before1672(), 'unterlagen'];
    const state: Record<string, unknown> = { attachmentReminderKeywords: own, explicitSettings: ['attachmentReminderKeywords'] };
    migrateAttachmentKeywordsDefault(state);
    expect(state.attachmentReminderKeywords).toEqual(own);

    const chosenOld: Record<string, unknown> = { attachmentReminderKeywords: before1672(), explicitSettings: ['attachmentReminderKeywords'] };
    migrateAttachmentKeywordsDefault(chosenOld);
    expect(chosenOld.attachmentReminderKeywords).toEqual(before1672());
  });

  it('takes the new list from a server copy or an older stored version', () => {
    expect(useSettingsStore.getState().importSettings(JSON.stringify({ attachmentReminderKeywords: before1672(), explicitSettings: [] }))).toBe(true);
    expect(useSettingsStore.getState().attachmentReminderKeywords).toContain('beigefügt');
    const out = migrateSettings({ attachmentReminderKeywords: before1672(), explicitSettings: [] }, 16) as unknown as Record<string, unknown>;
    expect(out.attachmentReminderKeywords).toContain('in der anlage');
  });
});
