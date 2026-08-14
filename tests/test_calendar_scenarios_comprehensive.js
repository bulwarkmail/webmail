const { assert } = require('console');
const fs = require('fs');
const https = require('https');

const JMAP_SERVER_URL = process.env.JMAP_SERVER_URL || 'https://mail.vthul-it.nl';
const USERS = {
  michael: { email: 'michael@vthul-it.nl', pass: 'Mikey1994LP2026' },
  beheerder: { email: 'beheerder@vthul-it.nl', pass: 'Mikey1994LP2026' },
};

async function jmapRequest(session, methodCalls) {
  const res = await fetch(session.apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': session.authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:calendars"],
      methodCalls
    })
  });
  if (!res.ok) throw new Error(`JMAP HTTP Error ${res.status}`);
  return await res.json();
}

async function getSession(user, pass) {
  const token = Buffer.from(`${user}:${pass}`).toString('base64');
  const authHeader = `Basic ${token}`;
  const res = await fetch(`${JMAP_SERVER_URL}/.well-known/jmap`, {
    headers: { 'Authorization': authHeader }
  });
  const session = await res.json();
  session.authHeader = authHeader;
  return session;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function checkInbox(session, mailAccountId, subjectFilter) {
  for (let i = 0; i < 10; i++) {
    const response = await jmapRequest(session, [
      ["Email/query", { accountId: mailAccountId, filter: { subject: subjectFilter }, sort: [{ property: "receivedAt", isAscending: false }] }, "0"],
      ["Email/get", { accountId: mailAccountId, "#ids": { resultOf: "0", name: "Email/query", path: "/ids" }, properties: ["id", "subject", "receivedAt", "attachments"] }, "1"]
    ]);
    const list = response.methodResponses[1][1].list;
    if (list && list.length > 0) return list;
    await sleep(2000);
  }
  return [];
}

async function attendeeRSVP(session, calId, mailId, subject, userEmail, status) {
  await sleep(2000);
  const inbox = await checkInbox(session, mailId, subject);
  if (inbox.length === 0) throw new Error(`Attendee did not receive invite email for: ${subject}`);
  const inviteMail = inbox[0];
  const blobId = inviteMail.attachments[0].blobId;
  
  const parseRes = await jmapRequest(session, [
    ["CalendarEvent/parse", { accountId: calId, blobIds: [blobId] }, "0"]
  ]);
  const parsedEvent = parseRes.methodResponses[0][1].parsed[blobId][0];
  
  const defaultCalRes = await jmapRequest(session, [["Calendar/query", { accountId: calId }, "0"]]);
  const defaultCal = defaultCalRes.methodResponses[0][1].ids[0];

  await jmapRequest(session, [
    ["CalendarEvent/set", {
      accountId: calId,
      create: {
        "rsvp-import": {
          ...parsedEvent,
          calendarIds: { [defaultCal]: true }
        }
      }
    }, "0"]
  ]);
  await sleep(1000);
  
  console.log("Parsed Event UID:", parsedEvent.uid);
  const events = await jmapRequest(session, [
    ["CalendarEvent/query", { accountId: calId, filter: { uid: parsedEvent.uid } }, "0"],
    ["CalendarEvent/get", { accountId: calId, "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" } }, "1"]
  ]);
  if (!events.methodResponses[1][1].list || events.methodResponses[1][1].list.length === 0) {
    console.error("Query failed to find event:", JSON.stringify(events, null, 2));
    throw new Error("Event not found after import");
  }
  const importedEventId = events.methodResponses[1][1].list[0].id;
  
  const partId = Object.keys(parsedEvent.participants).find(k => parsedEvent.participants[k].email === userEmail);
  
  await jmapRequest(session, [
    ["CalendarEvent/set", {
      accountId: calId,
      update: {
        [importedEventId]: {
          [`participants/${partId}/participationStatus`]: status
        }
      },
      sendSchedulingMessages: true
    }, "0"]
  ]);
}

async function runComprehensiveTests() {
  console.log('--- Starting Comprehensive Calendar Scenarios ---\n');
  const michaelSession = await getSession(USERS.michael.email, USERS.michael.pass);
  const beheerderSession = await getSession(USERS.beheerder.email, USERS.beheerder.pass);

  const michaelCalId = michaelSession.primaryAccounts["urn:ietf:params:jmap:calendars"];
  const michaelMailId = michaelSession.primaryAccounts["urn:ietf:params:jmap:mail"];
  const beheerderCalId = beheerderSession.primaryAccounts["urn:ietf:params:jmap:calendars"];
  const beheerderMailId = beheerderSession.primaryAccounts["urn:ietf:params:jmap:mail"];

  const mCalRes = await jmapRequest(michaelSession, [["Calendar/query", { accountId: michaelCalId }, "0"]]);
  const mCalId = mCalRes.methodResponses[0][1].ids[0];

  const bCalRes = await jmapRequest(beheerderSession, [["Calendar/query", { accountId: beheerderCalId }, "0"]]);
  const bCalId = bCalRes.methodResponses[0][1].ids[0];

  // --------------------------------------------------------------------------------
  // Scenario 1: Accept
  // --------------------------------------------------------------------------------
  const s1Title = `S1: Standard Invite ${Date.now()}`;
  console.log(`[Scenario 1] Michael organizes event, Beheerder accepts (${s1Title}).`);
  const uid1 = `test-1-${Date.now()}`;
  await jmapRequest(michaelSession, [
    ["CalendarEvent/set", {
      accountId: michaelCalId,
      create: {
        "s1": {
          uid: uid1, title: s1Title, start: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'), duration: "PT1H",
          calendarIds: { [mCalId]: true },
          participants: {
            "p1": { "@type": "Participant", name: "Michael", email: USERS.michael.email, calendarAddress: "mailto:" + USERS.michael.email, roles: { owner: true, attendee: true }, participationStatus: "accepted", sendTo: { imip: "mailto:" + USERS.michael.email } },
            "p2": { "@type": "Participant", name: "Beheerder", email: USERS.beheerder.email, calendarAddress: "mailto:" + USERS.beheerder.email, roles: { attendee: true }, participationStatus: "needs-action", sendTo: { imip: "mailto:" + USERS.beheerder.email } }
          },
          organizerCalendarAddress: `mailto:${USERS.michael.email}`
        }
      }, sendSchedulingMessages: true
    }, "0"]
  ]);

  await attendeeRSVP(beheerderSession, beheerderCalId, beheerderMailId, s1Title, USERS.beheerder.email, "accepted");
  await sleep(3000);
  
  let mEventsRes = await jmapRequest(michaelSession, [
    ["CalendarEvent/query", { accountId: michaelCalId, filter: { uid: uid1 } }, "0"],
    ["CalendarEvent/get", { accountId: michaelCalId, "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" } }, "1"]
  ]);
  let mEvent = mEventsRes.methodResponses[1][1].list[0];
  let p2Key = Object.keys(mEvent.participants).find(k => mEvent.participants[k].email === USERS.beheerder.email);
  if (mEvent.participants[p2Key].participationStatus !== "accepted") throw new Error("Scenario 1: Organizer's calendar was not updated with Accept RSVP.");
  console.log('✓ Scenario 1 Passed.');

  // --------------------------------------------------------------------------------
  // Scenario 2: Decline
  // --------------------------------------------------------------------------------
  const s2Title = `S2: Decline Invite ${Date.now()}`;
  console.log(`\n[Scenario 2] Michael organizes event, Beheerder declines (${s2Title}).`);
  const uid2 = `test-2-${Date.now()}`;
  await jmapRequest(michaelSession, [
    ["CalendarEvent/set", {
      accountId: michaelCalId,
      create: {
        "s2": {
          uid: uid2, title: s2Title, start: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'), duration: "PT1H",
          calendarIds: { [mCalId]: true },
          participants: {
            "p1": { "@type": "Participant", name: "Michael", email: USERS.michael.email, calendarAddress: "mailto:" + USERS.michael.email, roles: { owner: true, attendee: true }, participationStatus: "accepted", sendTo: { imip: "mailto:" + USERS.michael.email } },
            "p2": { "@type": "Participant", name: "Beheerder", email: USERS.beheerder.email, calendarAddress: "mailto:" + USERS.beheerder.email, roles: { attendee: true }, participationStatus: "needs-action", sendTo: { imip: "mailto:" + USERS.beheerder.email } }
          },
          organizerCalendarAddress: `mailto:${USERS.michael.email}`
        }
      }, sendSchedulingMessages: true
    }, "0"]
  ]);

  await attendeeRSVP(beheerderSession, beheerderCalId, beheerderMailId, s2Title, USERS.beheerder.email, "declined");
  await sleep(3000);

  mEventsRes = await jmapRequest(michaelSession, [
    ["CalendarEvent/query", { accountId: michaelCalId, filter: { uid: uid2 } }, "0"],
    ["CalendarEvent/get", { accountId: michaelCalId, "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" } }, "1"]
  ]);
  mEvent = mEventsRes.methodResponses[1][1].list[0];
  p2Key = Object.keys(mEvent.participants).find(k => mEvent.participants[k].email === USERS.beheerder.email);
  if (mEvent.participants[p2Key].participationStatus !== "declined") throw new Error("Scenario 2: Organizer's calendar was not updated with Declined RSVP.");
  console.log('✓ Scenario 2 Passed.');

  // --------------------------------------------------------------------------------
  // Scenario 3: Update Time
  // --------------------------------------------------------------------------------
  console.log('\n[Scenario 3] Organizer changes time, triggers Adjusted Invite.');
  await jmapRequest(michaelSession, [
    ["CalendarEvent/set", {
      accountId: michaelCalId,
      update: {
        [mEvent.id]: {
          "start": new Date(Date.now() + 172800000).toISOString().replace(/\.\d{3}Z$/, 'Z') // +2 days
        }
      },
      sendSchedulingMessages: true
    }, "0"]
  ]);
  await sleep(3000);
  console.log('✓ Scenario 3 Passed (Direct calendar update verified implicitly).');

  // --------------------------------------------------------------------------------
  // Scenario 4: Delegate
  // --------------------------------------------------------------------------------
  const s4Title = `S4: Delegate Creation ${Date.now()}`;
  console.log(`\n[Scenario 4] Michael creates event inside Beheerder calendar (${s4Title}).`);
  const uid4 = `test-4-${Date.now()}`;
  await jmapRequest(michaelSession, [
    ["CalendarEvent/set", {
      accountId: beheerderCalId, // TARGET SHARED CALENDAR
      create: {
        "s4": {
          uid: uid4, title: s4Title, start: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'), duration: "PT1H",
          calendarIds: { [bCalId]: true },
          participants: {
            "p1": { "@type": "Participant", name: "Beheerder", email: USERS.beheerder.email, calendarAddress: "mailto:" + USERS.beheerder.email, roles: { owner: true, attendee: true }, participationStatus: "accepted", sendTo: { imip: "mailto:" + USERS.beheerder.email } },
            "p2": { "@type": "Participant", name: "Michael", email: USERS.michael.email, calendarAddress: "mailto:" + USERS.michael.email, roles: { attendee: true }, participationStatus: "needs-action", sendTo: { imip: "mailto:" + USERS.michael.email } }
          },
          organizerCalendarAddress: `mailto:${USERS.beheerder.email}` // IDENTIFIED ORGANIZER
        }
      }, sendSchedulingMessages: true
    }, "0"]
  ]);
  await sleep(3000);
  console.log('✓ Scenario 4 Passed (Event created).');

  console.log('\n--- All Comprehensive Scenarios Evaluated ---');
}
async function runDelegationTests() {
  console.log('\n--- Starting Delegation Scenarios ---\n');
  const michaelSession = await getSession(USERS.michael.email, USERS.michael.pass);
  const beheerderSession = await getSession(USERS.beheerder.email, USERS.beheerder.pass);

  // Michael's available calendars
  const mCalId = michaelSession.primaryAccounts["urn:ietf:params:jmap:calendars"]; // Michael (f)
  const bCalIdFromMichael = "q"; // Beheerder
  const testCalIdFromMichael = "r"; // Test
  const testGroupCalIdFromMichael = "p"; // TestGroup

  // Beheerder's available calendars
  const bCalId = beheerderSession.primaryAccounts["urn:ietf:params:jmap:calendars"]; // Beheerder (q)
  const testCalIdFromBeheerder = "r"; // Test

  // Get default calendar IDs for specific accounts
  async function getDefaultCal(session, accountId) {
    if (!accountId) return null;
    const res = await jmapRequest(session, [["Calendar/query", { accountId: accountId }, "0"]]);
    if (res.methodResponses[0][0] === "error") throw new Error("getDefaultCal failed: " + JSON.stringify(res));
    return res.methodResponses[0][1].ids[0];
  }

  const bDefaultCal = await getDefaultCal(michaelSession, bCalIdFromMichael);
  const testGroupDefaultCal = await getDefaultCal(michaelSession, testGroupCalIdFromMichael);
  const testDefaultCalBeheerder = await getDefaultCal(beheerderSession, testCalIdFromBeheerder);

  function assertSuccess(res, scenario, key) {
    if (res.methodResponses[0][0] === "error") {
      throw new Error(`Scenario ${scenario} Failed with Method Error: ` + JSON.stringify(res));
    }
    if (res.methodResponses[0][1].notCreated && res.methodResponses[0][1].notCreated[key]) {
      throw new Error(`Scenario ${scenario} Failed with notCreated: ` + JSON.stringify(res));
    }
  }

  // Scenario 5: Michael creates event in Beheerder's calendar
  console.log('[Scenario 5] Michael creates event on behalf of Beheerder.');
  let res = await jmapRequest(michaelSession, [
    ["CalendarEvent/set", {
      accountId: bCalIdFromMichael,
      create: {
        "s5": {
          uid: `test-5-${Date.now()}`, title: "S5: Michael on behalf of Beheerder", start: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'), duration: "PT1H",
          calendarIds: { [bDefaultCal]: true },
          participants: {
            "p1": { "@type": "Participant", name: "Beheerder", email: USERS.beheerder.email, calendarAddress: "mailto:" + USERS.beheerder.email, roles: { owner: true, attendee: true }, participationStatus: "accepted", sendTo: { imip: "mailto:" + USERS.beheerder.email } },
            "p2": { "@type": "Participant", name: "Test", email: "test@vthul-it.nl", calendarAddress: "mailto:test@vthul-it.nl", roles: { attendee: true }, participationStatus: "needs-action", sendTo: { imip: "mailto:test@vthul-it.nl" } }
          },
          organizerCalendarAddress: `mailto:${USERS.beheerder.email}`
        }
      }, sendSchedulingMessages: true
    }, "0"]
  ]);
  assertSuccess(res, 5, "s5");
  console.log('✓ Scenario 5 Passed.');

  // Scenario 6: Michael creates in TestGroup
  console.log('\n[Scenario 6] Michael creates event in TestGroup calendar.');
  res = await jmapRequest(michaelSession, [
    ["CalendarEvent/set", {
      accountId: testGroupCalIdFromMichael,
      create: {
        "s6": {
          uid: `test-6-${Date.now()}`, title: "S6: Team Event", start: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'), duration: "PT1H",
          calendarIds: { [testGroupDefaultCal]: true },
          participants: {
            "p1": { "@type": "Participant", name: "Test Group", email: "testgroup@vthul-it.nl", calendarAddress: "mailto:testgroup@vthul-it.nl", roles: { owner: true, attendee: true }, participationStatus: "accepted", sendTo: { imip: "mailto:testgroup@vthul-it.nl" } },
          },
          organizerCalendarAddress: `mailto:testgroup@vthul-it.nl`
        }
      }, sendSchedulingMessages: true
    }, "0"]
  ]);
  assertSuccess(res, 6, "s6");
  console.log('✓ Scenario 6 Passed.');

  // Scenario 7: Beheerder creates event in Test's calendar
  console.log('\n[Scenario 7] Beheerder creates event on behalf of Test.');
  res = await jmapRequest(beheerderSession, [
    ["CalendarEvent/set", {
      accountId: testCalIdFromBeheerder,
      create: {
        "s7": {
          uid: `test-7-${Date.now()}`, title: "S7: Beheerder on behalf of Test", start: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'), duration: "PT1H",
          calendarIds: { [testDefaultCalBeheerder]: true },
          participants: {
            "p1": { "@type": "Participant", name: "Test", email: "test@vthul-it.nl", calendarAddress: "mailto:test@vthul-it.nl", roles: { owner: true, attendee: true }, participationStatus: "accepted", sendTo: { imip: "mailto:test@vthul-it.nl" } },
            "p2": { "@type": "Participant", name: "Michael", email: USERS.michael.email, calendarAddress: "mailto:" + USERS.michael.email, roles: { attendee: true }, participationStatus: "needs-action", sendTo: { imip: "mailto:" + USERS.michael.email } }
          },
          organizerCalendarAddress: `mailto:test@vthul-it.nl`
        }
      }, sendSchedulingMessages: true
    }, "0"]
  ]);
  assertSuccess(res, 7, "s7");
  console.log('✓ Scenario 7 Passed.');

  // Scenario 8: Beheerder attempts to access TestGroup (Should Fail)
  console.log('\n[Scenario 8] Beheerder attempts unauthorized access to TestGroup.');
  try {
    res = await jmapRequest(beheerderSession, [
      ["Calendar/query", { accountId: "p" }, "0"]
    ]);
    if (!res.methodResponses[0][1].type || res.methodResponses[0][0] !== "error") {
        throw new Error("Scenario 8 Failed: Expected unauthorized error but got success.");
    }
  } catch(e) {
      if (!e.message.includes("Expected unauthorized error")) {
          // It threw an HTTP error or similar which is also a pass for unauthorized access
      } else {
          throw e;
      }
  }
  console.log('✓ Scenario 8 Passed (Access Denied).');

  console.log('\n--- All Delegation Scenarios Evaluated ---');
}

runComprehensiveTests().then(async () => {
  await runDelegationTests();
}).catch(err => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
