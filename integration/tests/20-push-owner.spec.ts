import { test, expect } from '@playwright/test';
import { ACCOUNTS, GROUP, WEBMAIL_URL } from './helpers/config';
import { JmapClient } from './helpers/jmap';
import { login, seedSettings, folderRow, expandSharedFolders, emailItem, addAccount, switchAccount } from './helpers/app';
import { pushClick } from '../../lib/__tests__/helpers/push-click';

test.describe('notification target across personal and shared accounts (#1491)', () => {
  const cases = [false, true].flatMap(shared => [1, 3].flatMap(unread =>
    [false, true].map(warm => ({ shared, unread, warm, secondary: false })),
  ));
  cases.push(...[1, 3].map(unread => ({ shared: true, unread, warm: true, secondary: true })));
  for (const { shared, unread, warm, secondary } of cases) {
    test(`${shared ? 'shared' : 'personal'}, ${unread} unread, ${warm ? 'existing' : 'new'} window${secondary ? ', second login' : ''}`, async ({ page }) => {
      const member = ACCOUNTS.carol;
      const client = await JmapClient.connect(member.email, member.password);
      const sharedId = client.accountIdByName(GROUP.team.email);
      await client.reset();
      await client.reset(sharedId);
      const targetId = shared ? sharedId : client.accountId;
      let deliveredId = '';
      const subject = `Push target ${shared ? 'shared' : 'personal'} ${unread}`;
      for (const owner of [client.accountId, sharedId]) {
        const inbox = (await client.mailboxByRole('inbox', owner))!;
        for (let i = 0; i < unread; i++) {
          const result = await client.request([['Email/set', {
            accountId: owner,
            create: { mail: {
              mailboxIds: { [inbox.id]: true }, keywords: {},
              from: [{ email: ACCOUNTS.alice.email }],
              to: [{ email: owner === sharedId ? GROUP.team.email : member.email }],
              subject: owner === targetId ? `${subject} ${i}` : `Other mailbox ${i}`,
              receivedAt: new Date(Date.now() + i * 1000).toISOString(),
              textBody: [{ partId: 'b', type: 'text/plain' }],
              bodyValues: { b: { value: `Body in ${owner}` } },
            } },
          }, '0']]);
          expect(result.methodResponses[0][1].created?.mail).toBeTruthy();
          if (owner === targetId) deliveredId = result.methodResponses[0][1].created.mail.id;
        }
      }
      await seedSettings(page, { enableUnifiedMailbox: false, mailLayout: 'split' });
      if (secondary) {
        await login(page, ACCOUNTS.bob);
        await addAccount(page, member);
        await switchAccount(page, ACCOUNTS.bob.email);
      } else {
        await login(page, member);
      }
      await expect(folderRow(page, { role: 'inbox', shared: false }).first()).toHaveAttribute('data-selected', 'true');
      const target = await pushClick(targetId, async (url) => {
        const response = await page.request.get(new URL(url, WEBMAIL_URL).href);
        expect(response.status()).toBe(200);
        const preview = await response.json();
        expect(preview.unreadTotal).toBe(unread);
        expect(preview.slot).toBe(secondary ? 1 : 0);
        expect(preview.email.subject).toBe(`${subject} ${unread - 1}`);
        return preview;
      }, { warm, emailId: deliveredId });
      if (!warm) {
        const nextPage = await page.context().newPage();
        await page.close();
        page = nextPage;
      }
      await page.goto(target);
      if (unread === 1) {
        await expect(page.locator('[data-tour="email-viewer"]')).toContainText(`${subject} 0`);
      }
      if (shared) await expandSharedFolders(page, GROUP.team.email);
      await expect(folderRow(page, { role: 'inbox', shared }).first()).toHaveAttribute('data-selected', 'true');
      if (unread > 1) {
        await expect(emailItem(page, `${subject} ${unread - 1}`).first()).toBeVisible();
      }
    });
  }
});
