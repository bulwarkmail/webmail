import { test, expect } from '@playwright/test';
import { ACCOUNTS, GROUP } from './helpers/config';
import { JmapClient } from './helpers/jmap';
import { login, forceSync, openComposer, composerFromOptions } from './helpers/app';

/**
 * Issue #569 — the composer's "From" dropdown should include identities from
 * shared/group accounts, not only the logged-in (connected) accounts.
 *
 * Scenario under test (the one expected to already work): a Stalwart *group*
 * mailbox `team@example.org` is provisioned and `carol` is made a member of it
 * *before her first login* (integration/stalwart/plan-accounts.ndjson.tpl +
 * entrypoint.sh). As a member she gets the group's shared folders (shown under
 * "Shared") and — per Stalwart — a `team@` send-as identity (Stalwart returns
 * it among the member's own account identities). The composer should therefore
 * offer `team@example.org` as a sender alongside her own address.
 */
const member = ACCOUNTS[GROUP.team.memberOf];
const { team } = GROUP;

test.describe('Composer From: shared/group identities (issue #569)', () => {
  test('the pre-provisioned group account is reachable in the member’s JMAP session', async () => {
    // Server-side guard for the UI expectation below: if this fails, the
    // bootstrap group provisioning is broken (not the app). The member must see
    // the group account in her session, and it must expose a team@ identity she
    // can send as.
    const memberClient = await JmapClient.connect(member.email, member.password);
    expect(memberClient.sharedAccountNames()).toContain(team.email);

    const groupAccountId = Object.entries(memberClient.accounts).find(
      ([, name]) => name === team.email,
    )?.[0];
    expect(groupAccountId).toBeTruthy();

    const res = await memberClient.request([
      ['Identity/get', { accountId: groupAccountId! }, '0'],
    ]);
    const groupIdentityEmails = (res.methodResponses[0][1].list as { email: string }[]).map(
      (i) => i.email,
    );
    expect(groupIdentityEmails).toContain(team.email);
  });

  test('the composer From selector offers the group address', async ({ page }) => {
    await login(page, member);
    // Shared accounts/identities are discovered from the JMAP session; give the
    // client a beat to settle them after the first render.
    await forceSync(page);

    await openComposer(page);

    // The group address alice can send as should be one of the From choices.
    // If #569 is unaddressed the control collapses to her own address only and
    // this poll times out — which is the point: it pins the expected behaviour.
    await expect
      .poll(async () => (await composerFromOptions(page)).join(' | '), { timeout: 15000 })
      .toContain(team.email);
  });
});
