import { describe, expect, it } from 'vitest';
import { defaultZone, fileDropZones, filesWithinLimits, kindForType, MAX_ZONES, type DropFiles, type DropPlace } from '../zones';

const place = (patch: Partial<DropPlace> = {}): DropPlace => ({
  composer: false,
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
const ids = (files: DropFiles, where: DropPlace) => fileDropZones(files, where).map((zone) => zone.id);

describe('the file drop zones', () => {
  it('offer a new message and Files for any file', () => {
    expect(ids(drag(['other']), place())).toEqual(['new-message', 'upload']);
  });

  it('leave Files out where the server or the organisation has none', () => {
    expect(ids(drag(['other']), place({ files: false }))).toEqual(['new-message']);
  });

  it('put an open composer first', () => {
    expect(ids(drag(['other', 'other']), place({ composer: true }))).toEqual(['attach-here', 'new-message', 'upload']);
  });

  it('name the folder on the Files screen', () => {
    const upload = fileDropZones(drag(['other']), place({ filesFolder: 'Reports' })).find((zone) => zone.id === 'upload');
    expect(upload?.folder).toBe('Reports');
  });

  it('add the calendar for one .ics, contacts for one .vcf, open and import for an .eml', () => {
    expect(ids(drag(['calendar']), place())).toEqual(['calendar', 'new-message', 'upload']);
    expect(ids(drag(['contacts']), place())).toEqual(['contacts', 'new-message', 'upload']);
    expect(ids(drag(['eml']), place({ importFolder: 'Inbox' }))).toEqual(['open-eml', 'import-eml', 'new-message', 'upload']);
  });

  it('offer nothing special for a mix or for a calendar the account does not have', () => {
    expect(ids(drag(['calendar', 'other']), place())).toEqual(['new-message', 'upload']);
    expect(ids(drag(['calendar']), place({ calendar: false }))).toEqual(['new-message', 'upload']);
    expect(ids({ count: null, kinds: null, bytes: null }, place())).toEqual(['new-message', 'upload']);
  });

  it('import several messages, but open only one', () => {
    expect(ids(drag(['eml', 'eml']), place({ importFolder: 'Inbox' }))).toEqual(['import-eml', 'new-message', 'upload']);
  });

  it('never show more than four, keeping both main ones and the composer', () => {
    const zones = ids(drag(['eml']), place({ composer: true, importFolder: 'Inbox' }));
    expect(zones).toHaveLength(MAX_ZONES);
    expect(zones).toEqual(['attach-here', 'open-eml', 'new-message', 'upload']);
  });

  it('in a pop-out, only its own composer', () => {
    expect(ids(drag(['calendar']), place({ popout: true, composer: true }))).toEqual(['attach-here']);
    expect(ids(drag(['other']), place({ popout: true }))).toEqual([]);
  });

  it('offline: Files and the import say they need a connection, a draft without offline mode too', () => {
    const zones = fileDropZones(drag(['eml']), place({ offline: true, importFolder: 'Inbox' }));
    const byId = Object.fromEntries(zones.map((zone) => [zone.id, zone]));
    expect(byId.upload).toMatchObject({ disabled: true, note: { key: 'note_needs_connection' } });
    expect(byId['import-eml']).toMatchObject({ disabled: true });
    expect(byId['new-message']).toMatchObject({ disabled: true, note: { key: 'note_needs_connection' } });
    expect(byId['open-eml'].disabled).toBeUndefined();
  });

  it('offline with offline mode: a draft keeps the files until the connection is back', () => {
    const zones = fileDropZones(drag(['other']), place({ offline: true, keepsOffline: true }));
    expect(zones.find((zone) => zone.id === 'new-message')).toEqual({ id: 'new-message', note: { key: 'note_kept_offline' } });
  });

  it('show the server limits while the sizes are still unknown', () => {
    const zones = fileDropZones(drag(['other']), place({ maxUploadBytes: 50, maxMessageBytes: 100 }));
    expect(zones.find((zone) => zone.id === 'new-message')?.note).toEqual({ key: 'note_limit_message', size: 100 });
    expect(zones.find((zone) => zone.id === 'upload')?.note).toEqual({ key: 'note_limit_file', size: 50 });
  });

  it('read the kind from the MIME type a drag shows', () => {
    expect(kindForType('text/calendar')).toBe('calendar');
    expect(kindForType('message/rfc822')).toBe('eml');
    expect(kindForType('text/x-vcard')).toBe('contacts');
    expect(kindForType('')).toBe('other');
  });
});

describe('limits once the files are in hand', () => {
  const sized = (name: string, size: number) => new File([new Uint8Array(size)], name);

  it('leave out a file over the per-file limit and keep the rest', () => {
    const big = sized('big.zip', 60);
    const small = sized('a.txt', 10);
    expect(filesWithinLimits('upload', [big, small], { maxUploadBytes: 50, maxMessageBytes: 0 })).toEqual({ fitting: [small], tooLarge: [big], overMessage: false });
  });

  it('refuse a message whose files are too large together', () => {
    const files = [sized('a', 30), sized('b', 30)];
    expect(filesWithinLimits('new-message', files, { maxUploadBytes: 0, maxMessageBytes: 50 })).toMatchObject({ fitting: [], overMessage: true });
    expect(filesWithinLimits('upload', files, { maxUploadBytes: 0, maxMessageBytes: 50 }).fitting).toHaveLength(2);
  });
});

describe('the keyboard default', () => {
  it('is the asked-for zone when usable, else the first usable', () => {
    const zones = fileDropZones(drag(['other']), place({ composer: true }));
    expect(defaultZone(zones, 'new-message')?.id).toBe('new-message');
    expect(defaultZone(zones)?.id).toBe('attach-here');
    const offline = fileDropZones(drag(['other']), place({ offline: true, keepsOffline: true }));
    expect(defaultZone(offline, 'upload')?.id).toBe('new-message');
  });
});
