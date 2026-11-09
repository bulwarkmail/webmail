import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import {
  announcementActive,
  announcementKey,
  announcementParts,
  announcementText,
  dismissAnnouncement,
  isAnnouncementDismissed,
  nextAnnouncementChange,
  type Announcement,
} from '@/lib/org-announcement';

const base: Announcement = {
  ...DEFAULT_ORGANISATION_POLICY.announcement,
  id: 'a1',
  text: { en: 'Maintenance tonight', de: 'Wartung heute Nacht', 'pt-BR': 'Manutenção' },
  fallbackLocale: 'de',
};

describe('announcementText', () => {
  it('picks the exact locale, then the language, then the fallback', () => {
    expect(announcementText(base, 'de')).toBe('Wartung heute Nacht');
    expect(announcementText(base, 'en')).toBe('Maintenance tonight');
    expect(announcementText(base, 'pt')).toBe('Manutenção');
    expect(announcementText(base, 'de-AT')).toBe('Wartung heute Nacht');
    expect(announcementText(base, 'fr')).toBe('Wartung heute Nacht');
  });

  it('falls back to the first text when the fallback locale has none', () => {
    expect(announcementText({ ...base, text: { nl: 'Onderhoud' }, fallbackLocale: 'en' }, 'fr')).toBe('Onderhoud');
  });

  it('is empty without text', () => {
    expect(announcementText({ ...base, text: {} }, 'en')).toBe('');
    expect(announcementText({ ...base, text: { en: '   ' } }, 'en')).toBe('');
    expect(announcementText(undefined, 'en')).toBe('');
  });
});

describe('start and end', () => {
  const window = { ...base, startsAt: '2026-11-02T08:00:00.000Z', endsAt: '2026-11-02T10:00:00.000Z' };
  const at = (iso: string) => Date.parse(iso);

  it('shows only between start and end', () => {
    expect(announcementActive(window, at('2026-11-02T07:59:59Z'))).toBe(false);
    expect(announcementActive(window, at('2026-11-02T08:00:00Z'))).toBe(true);
    expect(announcementActive(window, at('2026-11-02T09:59:59Z'))).toBe(true);
    expect(announcementActive(window, at('2026-11-02T10:00:00Z'))).toBe(false);
    expect(announcementActive(base, at('2030-01-01T00:00:00Z'))).toBe(true);
  });

  it('names the next change, so a timer can show and hide it', () => {
    expect(nextAnnouncementChange(window, at('2026-11-02T07:00:00Z'))).toBe(at('2026-11-02T08:00:00Z'));
    expect(nextAnnouncementChange(window, at('2026-11-02T09:00:00Z'))).toBe(at('2026-11-02T10:00:00Z'));
    expect(nextAnnouncementChange(window, at('2026-11-02T11:00:00Z'))).toBeNull();
    expect(nextAnnouncementChange(base, Date.now())).toBeNull();
  });
});

describe('dismissal', () => {
  beforeEach(() => localStorage.clear());

  it('is kept per account', () => {
    dismissAnnouncement(base, 'acc-1');
    expect(isAnnouncementDismissed(base, 'acc-1')).toBe(true);
    expect(isAnnouncementDismissed(base, 'acc-2')).toBe(false);
  });

  it('no longer holds once the admin edits the text or severity, or for a new announcement', () => {
    dismissAnnouncement(base, 'acc-1');
    expect(isAnnouncementDismissed({ ...base, text: { ...base.text, en: 'Maintenance moved to Friday' } }, 'acc-1')).toBe(false);
    expect(isAnnouncementDismissed({ ...base, severity: 'critical' }, 'acc-1')).toBe(false);
    expect(isAnnouncementDismissed({ ...base, id: 'a2' }, 'acc-1')).toBe(false);
  });

  it('still holds when only the start or end time moves', () => {
    dismissAnnouncement(base, 'acc-1');
    expect(isAnnouncementDismissed({ ...base, endsAt: '2026-12-01T00:00:00.000Z' }, 'acc-1')).toBe(true);
    expect(isAnnouncementDismissed({ ...base, startsAt: '2026-11-01T00:00:00.000Z' }, 'acc-1')).toBe(true);
  });

  it('does not depend on the order of the languages', () => {
    const reordered = { ...base, text: { 'pt-BR': base.text['pt-BR'], de: base.text.de, en: base.text.en } };
    expect(announcementKey(reordered)).toBe(announcementKey(base));
  });
});

describe('announcementParts', () => {
  it('turns web addresses into links and keeps a full stop outside', () => {
    expect(announcementParts('See https://status.example.org/x. Thanks')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', href: 'https://status.example.org/x' },
      { kind: 'text', text: '. Thanks' },
    ]);
  });

  it('never makes links of other schemes or of markup', () => {
    const parts = announcementParts('javascript:alert(1) <a href="https://x.test">x</a>');
    expect(parts.filter((p) => p.kind === 'link')).toEqual([{ kind: 'link', href: 'https://x.test' }]);
  });
});
