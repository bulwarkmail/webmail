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

  // Attachments always show under the header now: the Attachment position
  // setting is gone, and a value an older build stored must not linger
  // (locally, in an import or in the synced copy on the server).
  it('has no attachment position setting', () => {
    expect('attachmentPosition' in useSettingsStore.getState()).toBe(false);
    expect(JSON.parse(useSettingsStore.getState().exportSettings())).not.toHaveProperty('attachmentPosition');
  });

  it('drops a stored position and its "chosen" mark when local settings migrate', () => {
    for (const stored of ['below-message', 'below-header', 'beside-sender']) {
      const migrated = migrateSettings({ attachmentPosition: stored, explicitSettings: ['attachmentPosition', 'mailAttachmentAction'] }, 13) as unknown as Record<string, unknown>;
      expect(migrated).not.toHaveProperty('attachmentPosition');
      expect(migrated.explicitSettings).toEqual(['mailAttachmentAction']);
    }
  });

  it('does not count a position from before explicit settings as chosen', () => {
    const migrated = migrateSettings({ attachmentPosition: 'below-message' }, 7) as unknown as Record<string, unknown>;
    expect(migrated).not.toHaveProperty('attachmentPosition');
    expect(migrated.explicitSettings).not.toContain('attachmentPosition');
  });

  it('bumps the stored version so settings saved by the last build migrate too', () => {
    expect(useSettingsStore.persist.getOptions().version).toBeGreaterThanOrEqual(15);
  });

  it('forgets a position saved in this browser by the last build when the page loads', async () => {
    localStorage.setItem('settings-storage', JSON.stringify({
      state: { attachmentPosition: 'below-message', mailAttachmentAction: 'download', explicitSettings: ['attachmentPosition', 'mailAttachmentAction'] },
      version: 14,
    }));
    try {
      await useSettingsStore.persist.rehydrate();
      const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
      expect(state.mailAttachmentAction).toBe('download');
      expect(state).not.toHaveProperty('attachmentPosition');
      expect(state.explicitSettings).not.toContain('attachmentPosition');
      expect(localStorage.getItem('settings-storage')).not.toContain('attachmentPosition');
    } finally {
      localStorage.removeItem('settings-storage');
    }
  });

  it('ignores a position in settings synced from an older build', () => {
    const synced = { attachmentPosition: 'below-message', mailAttachmentAction: 'download', explicitSettings: ['attachmentPosition', 'mailAttachmentAction'] };
    expect(useSettingsStore.getState().importSettings(JSON.stringify(synced))).toBe(true);
    const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
    expect(state).not.toHaveProperty('attachmentPosition');
    expect(state.mailAttachmentAction).toBe('download');
    expect(state.explicitSettings).not.toContain('attachmentPosition');
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