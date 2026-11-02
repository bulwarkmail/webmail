import { beforeEach, describe, expect, it } from 'vitest';
import { migrateSettings, useSettingsStore } from '../settings-store';

describe('settings-store attachment action', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  it('enables quick reply by default and exports the disabled preference', () => {
    expect(useSettingsStore.getState().quickReplyEnabled).toBe(true);
    useSettingsStore.getState().updateSetting('quickReplyEnabled', false);
    expect(JSON.parse(useSettingsStore.getState().exportSettings()).quickReplyEnabled).toBe(false);
    useSettingsStore.getState().resetToDefaults();
    expect(useSettingsStore.getState().quickReplyEnabled).toBe(true);
  });

  it('shows attachments as a bar under the header by default', () => {
    expect(useSettingsStore.getState().attachmentPosition).toBe('below-header');
  });

  it('moves the retired beside-sender position to the bar', () => {
    const migrated = migrateSettings({ attachmentPosition: 'beside-sender', explicitSettings: [] }, 11) as unknown as Record<string, unknown>;
    expect(migrated.attachmentPosition).toBe('below-header');
    const cards = migrateSettings({ attachmentPosition: 'below-message', explicitSettings: [] }, 11) as unknown as Record<string, unknown>;
    expect(cards.attachmentPosition).toBe('below-message');
  });

  it('does not count the old default as chosen when older settings migrate', () => {
    const migrated = migrateSettings({ attachmentPosition: 'beside-sender' }, 7) as unknown as Record<string, unknown>;
    expect(migrated.explicitSettings).not.toContain('attachmentPosition');
  });

  it('moves beside-sender to the bar in settings synced from an older build', () => {
    useSettingsStore.getState().updateSetting('attachmentPosition', 'below-message');
    expect(useSettingsStore.getState().importSettings(JSON.stringify({ attachmentPosition: 'beside-sender' }))).toBe(true);
    expect(useSettingsStore.getState().attachmentPosition).toBe('below-header');
  });

  it('defaults to preview when settings are reset', () => {
    expect(useSettingsStore.getState().mailAttachmentAction).toBe('preview');
  });

  it('includes the attachment action in exported settings', () => {
    useSettingsStore.getState().updateSetting('mailAttachmentAction', 'download');

    const exported = JSON.parse(useSettingsStore.getState().exportSettings()) as {
      mailAttachmentAction?: string;
    };

    expect(exported.mailAttachmentAction).toBe('download');
  });

  it('includes calendar invitation parsing in exported settings', () => {
    useSettingsStore.getState().updateSetting('calendarInvitationParsingEnabled', false);

    const exported = JSON.parse(useSettingsStore.getState().exportSettings()) as {
      calendarInvitationParsingEnabled?: boolean;
    };

    expect(exported.calendarInvitationParsingEnabled).toBe(false);
  });

  it('includes reply identity auto-selection in exported settings', () => {
    useSettingsStore.getState().updateSetting('autoSelectReplyIdentity', true);

    const exported = JSON.parse(useSettingsStore.getState().exportSettings()) as {
      autoSelectReplyIdentity?: boolean;
    };

    expect(exported.autoSelectReplyIdentity).toBe(true);
  });
});