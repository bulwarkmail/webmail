// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkTargetsExist, parseMigrationCsv } from '../csv';

describe('migration CSV', () => {
  it('reads rows, quoted fields and an empty password with an admin login', () => {
    const csv = 'source_user,target_account,source_password\r\nalice,alice@example.com,"pa,ss""word"\nbob,bob@example.com,\n';
    const { rows, problems } = parseMigrationCsv(csv, { sourceHasAdminLogin: true });
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      { row: 2, sourceUser: 'alice', target: 'alice@example.com', password: 'pa,ss"word' },
      { row: 3, sourceUser: 'bob', target: 'bob@example.com', password: '' },
    ]);
  });

  it('names the row and the reason of every bad row', () => {
    const csv = [
      'source_user,target_account,source_password',
      'alice,alice@example.com,x',
      'bob',
      'carol,ALICE@example.com,y',
      ',dave@example.com,z',
      'erin,erin@example.com,',
    ].join('\n');
    const { rows, problems } = parseMigrationCsv(csv, { sourceHasAdminLogin: false });
    expect(rows.map((r) => r.row)).toEqual([2]);
    expect(problems).toEqual([
      { row: 3, reason: 'Missing column: target_account, source_password.' },
      { row: 4, reason: 'Duplicate target ALICE@example.com (also in row 2).' },
      { row: 5, reason: 'source_user is empty.' },
      { row: 6, reason: 'source_password is empty and the source has no admin login.' },
    ]);
  });

  it('refuses a wrong header', () => {
    const { problems } = parseMigrationCsv('user,target\nalice,alice@example.com', { sourceHasAdminLogin: true });
    expect(problems[0]).toMatchObject({ row: 1 });
    expect(problems[0].reason).toContain('missing: source_user');
  });

  it('reports targets Stalwart does not know', async () => {
    const { rows } = parseMigrationCsv('source_user,target_account,source_password\na,a@x,1\nb,b@x,2', { sourceHasAdminLogin: false });
    const problems = await checkTargetsExist(rows, async (target) => target === 'a@x');
    expect(problems).toEqual([{ row: 3, reason: 'Target b@x does not exist on Stalwart.' }]);
  });
});
