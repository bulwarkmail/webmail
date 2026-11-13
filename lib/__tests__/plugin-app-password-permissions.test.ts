import { describe, it, expect } from 'vitest';
import {
  appPasswordPermissions,
  appPasswordRights,
  checkAppPasswordPermissions,
} from '../plugin-secrets/app-password-permissions';

// What our team calendar plugin uses, measured against Stalwart 1.0.3.
const TEAM_CALENDAR = [
  'jmapCalendarGet', 'jmapCalendarUpdate', 'jmapCalendarEventGet', 'jmapCalendarEventQuery', 'jmapCalendarEventCreate',
  'jmapCalendarEventUpdate', 'jmapCalendarEventDestroy', 'jmapCalendarEventCopy', 'jmapPrincipalGet', 'jmapPrincipalQuery',
  'jmapPrincipalGetAvailability', 'jmapFileNodeGet', 'jmapFileNodeQuery', 'jmapBlobGet',
];

describe('app password permissions', () => {
  it("take a plugin's own data, sending and sign-in", () => {
    expect(checkAppPasswordPermissions({ permissions: TEAM_CALENDAR })).toEqual({ permissions: TEAM_CALENDAR });
    expect(checkAppPasswordPermissions({ permissions: ['imapAuthenticate', 'davCalPropFind', 'emailSend', 'authenticate'] }))
      .toEqual({ permissions: ['imapAuthenticate', 'davCalPropFind', 'emailSend', 'authenticate'] });
  });

  it('refuse the administration, other credentials, impersonation and blobs not the account\'s', () => {
    for (const name of ['sysAppPasswordCreate', 'sysApiKeyCreate', 'sysAccountGet', 'impersonate', 'fetchAnyBlob', 'scimAccess', 'actionReloadSettings']) {
      expect(checkAppPasswordPermissions({ permissions: [name] })).toEqual({ error: expect.stringContaining(`"${name}"`) });
    }
  });

  it('are asked of Stalwart with sign-in added, nothing else', () => {
    expect(appPasswordPermissions(['jmapCalendarGet'])).toEqual({ authenticate: true, jmapCalendarGet: true });
  });

  it('are named by area for the connect dialog', () => {
    expect(appPasswordRights(TEAM_CALENDAR)).toEqual({
      areas: [
        { area: 'calendars', access: 'change' },
        { area: 'files', access: 'read' },
        { area: 'directory', access: 'read' },
      ],
      other: [],
    });
    expect(appPasswordRights(['jmapEmailGet', 'jmapEmailSubmissionCreate', 'jmapContactCardGet', 'jmapQuotaGet', 'authenticate'])).toEqual({
      areas: [
        { area: 'mail', access: 'read' },
        { area: 'send', access: 'read' },
        { area: 'contacts', access: 'read' },
      ],
      other: ['jmapQuotaGet'],
    });
  });

  it('count anything that is not plainly a read as a change', () => {
    expect(appPasswordRights(['jmapMailboxGet', 'imapStore']).areas).toEqual([{ area: 'mail', access: 'change' }]);
  });
});
