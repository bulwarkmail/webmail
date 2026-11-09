import { describe, expect, it } from 'vitest';
import { fileDropZones, filesTakeDropsAsIs, type DropFiles, type DropPlace } from '../zones';

// Usability pass 2 (pim-p2-6, pim-p2-10).

const place = (patch: Partial<DropPlace> = {}): DropPlace => ({
  composer: false,
  inlineImages: false,
  popout: false,
  files: true,
  filesFolder: null,
  calendar: true,
  contacts: true,
  importFolder: null,
  offline: false,
  keepsOffline: false,
  maxUploadBytes: 0,
  maxMessageBytes: 0,
  ...patch,
});

const drag = (kinds: DropFiles['kinds']): DropFiles => ({ count: kinds?.length ?? null, kinds, bytes: null });

describe('on the Files screen a drop uploads where you are, with no question (pim-p2-6)', () => {
  it('has only the upload into the folder in view, for any kind of file', () => {
    for (const kinds of [['other'], ['calendar'], ['eml', 'eml'], ['image']] as DropFiles['kinds'][]) {
      expect(fileDropZones(drag(kinds), place({ onFiles: true, filesFolder: 'Documents' }))).toEqual([{ id: 'upload', folder: 'Documents' }]);
    }
    expect(filesTakeDropsAsIs(place({ onFiles: true }))).toBe(true);
  });

  it('still asks with a composer open, and on every other screen', () => {
    expect(filesTakeDropsAsIs(place({ onFiles: true, composer: true }))).toBe(false);
    expect(fileDropZones(drag(['other']), place({ onFiles: true, composer: true })).map((z) => z.id)).toEqual(['attach-here', 'new-message', 'upload']);
    expect(filesTakeDropsAsIs(place())).toBe(false);
    expect(fileDropZones(drag(['other']), place()).map((z) => z.id)).toEqual(['new-message', 'upload']);
  });
});

describe('several .ics or .vcf can be added together (pim-p2-10)', () => {
  it('offers "Add all to calendar" for two .ics', () => {
    const zones = fileDropZones(drag(['calendar', 'calendar']), place());
    expect(zones[0]).toEqual({ id: 'calendar', several: true });
  });

  it('offers "Add all to contacts" for three .vcf', () => {
    const zones = fileDropZones(drag(['contacts', 'contacts', 'contacts']), place());
    expect(zones[0]).toEqual({ id: 'contacts', several: true });
  });

  it('keeps the plain choice for one file', () => {
    expect(fileDropZones(drag(['calendar']), place())[0]).toEqual({ id: 'calendar' });
  });
});
