const assert = require('assert');

// Constants
const STALWART_URL = 'https://mail.vthul-it.nl';
const USERS = {
  michael: { email: 'michael@vthul-it.nl', password: 'Mikey1994LP2026' },
  beheerder: { email: 'beheerder@vthul-it.nl', password: 'Mikey1994LP2026' }
};

// Utility to authenticate and get a JMAP session
async function getJmapSession(user) {
  const token = Buffer.from(`${user.email}:${user.password}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${token}`,
    'Content-Type': 'application/json'
  };

  const response = await fetch(`${STALWART_URL}/.well-known/jmap`, { headers });
  if (!response.ok) throw new Error(`Failed to get session for ${user.email}`);
  const session = await response.json();
  return {
    headers,
    apiUrl: session.apiUrl,
    primaryAccounts: session.primaryAccounts
  };
}

// Utility to make JMAP requests
async function jmapRequest(session, methodCalls) {
  const response = await fetch(session.apiUrl, {
    method: 'POST',
    headers: session.headers,
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars", "urn:ietf:params:jmap:mail"],
      methodCalls
    })
  });
  if (!response.ok) throw new Error('JMAP request failed');
  return await response.json();
}

async function runTests() {
  console.log('--- Starting Calendar Delegation Tests ---');
  
  const michaelSession = await getJmapSession(USERS.michael);
  const beheerderSession = await getJmapSession(USERS.beheerder);
  
  const michaelAccountId = michaelSession.primaryAccounts['urn:ietf:params:jmap:calendars'];
  const beheerderAccountId = beheerderSession.primaryAccounts['urn:ietf:params:jmap:calendars'];
  const michaelMailAccountId = michaelSession.primaryAccounts['urn:ietf:params:jmap:mail'];
  const beheerderMailAccountId = beheerderSession.primaryAccounts['urn:ietf:params:jmap:mail'];

  console.log('Got JMAP Sessions.');

  // Step 1: Get Beheerder's Calendar ID
  let response = await jmapRequest(michaelSession, [
    ["Calendar/get", { accountId: beheerderAccountId }, "0"]
  ]);
  const beheerderCalendars = response.methodResponses[0][1].list;
  const beheerderPrimaryCalendar = beheerderCalendars.find(c => c.isDefault) || beheerderCalendars[0];
  const calendarId = beheerderPrimaryCalendar.id;
  
  console.log(`Found Beheerder Calendar ID: ${calendarId}`);

  // Scenario: Michael creates an event in Beheerder's calendar (Send on Behalf Of)
  const eventUid = `test-delegation-${Date.now()}`;
  const eventData = {
    uid: eventUid,
    title: "Automated Delegation Test",
    start: new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration: "PT1H",
    calendarIds: { [calendarId]: true },
    participants: {
      "part-1": {
        "@type": "Participant",
        name: "Beheerder Organizer",
        email: USERS.beheerder.email,
        roles: { owner: true, attendee: true },
        participationStatus: "accepted",
        sendTo: { imip: "mailto:" + USERS.beheerder.email }
      },
      "part-2": {
        "@type": "Participant",
        name: "Michael Attendee",
        email: USERS.michael.email,
        roles: { attendee: true },
        participationStatus: "needs-action",
        sendTo: { imip: "mailto:" + USERS.michael.email }
      }
    },
    // The key fix: The organizer address is the shared calendar owner, not the authenticated user.
    organizerCalendarAddress: `mailto:${USERS.beheerder.email}`
  };

  console.log('Michael is creating the event in Beheerder\'s calendar...');
  response = await jmapRequest(michaelSession, [
    ["CalendarEvent/set", {
      accountId: beheerderAccountId,
      create: {
        "event-1": eventData
      },
      sendSchedulingMessages: true
    }, "0"]
  ]);

  const createdId = response.methodResponses[0][1].created["event-1"]?.id;
  assert(createdId, "Failed to create event");
  console.log(`Event Created. ID: ${createdId}`);

  // Scenario Verification:
  // Since Beheerder is the Organizer, Michael should receive an invite in his Inbox, 
  // but Michael should NOT receive any RSVPs (unless he is the organizer).
  // Furthermore, when Michael (Attendee) accepts, the RSVP should go to Beheerder.

  // Step 2: Michael accepts the event
  console.log('Michael accepts the event...');
  const acceptData = { ...eventData };
  acceptData.participants["part-2"].participationStatus = "accepted";
  
  response = await jmapRequest(michaelSession, [
    ["CalendarEvent/set", {
      accountId: michaelAccountId,
      create: {
        "event-imported": {
          ...acceptData,
          calendarIds: { [(await getPrimaryCalendar(michaelSession, michaelAccountId))]: true }
        }
      },
      sendSchedulingMessages: true
    }, "0"]
  ]);
  
  console.log('Event imported to Michael\'s calendar and RSVP sent.');

  // Step 3: Verify Beheerder's mailbox for the RSVP (and lack of bijgewerkte uitnodiging)
  console.log('Waiting 3 seconds for emails to route...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('Verifying Beheerder Inbox for the RSVP...');
  response = await jmapRequest(beheerderSession, [
    ["Email/query", { accountId: beheerderMailAccountId, filter: { subject: "Automated Delegation Test" } }, "0"],
    ["Email/get", { accountId: beheerderMailAccountId, "#ids": { resultOf: "0", name: "Email/query", path: "/ids" }, properties: ["subject", "from"] }, "1"]
  ]);

  const emails = response.methodResponses[1][1].list;
  const isRsvpPresent = emails.some(e => e.subject.toLowerCase().includes("accepted") || e.subject.toLowerCase().includes("geaccepteerd"));
  const isAdjustedInvitePresent = emails.some(e => e.subject.toLowerCase().includes("bijgewerkte uitnodiging") || e.subject.toLowerCase().includes("adjusted invite") || e.subject.toLowerCase().includes("updated invitation"));

  assert(isRsvpPresent, "Beheerder did NOT receive the RSVP from Michael.");
  assert(!isAdjustedInvitePresent, "ERROR: An unexpected 'Adjusted Invite' (Bijgewerkte uitnodiging) was generated during delegation!");

  console.log('SUCCESS! Beheerder received the standard RSVP. No Adjusted Invite spam occurred.');
  console.log('All Calendar Delegation Tests Passed Successfully!');
}

async function getPrimaryCalendar(session, accountId) {
  const response = await jmapRequest(session, [["Calendar/get", { accountId }, "0"]]);
  const calendars = response.methodResponses[0][1].list;
  return (calendars.find(c => c.isDefault) || calendars[0]).id;
}

runTests().catch(err => {
  console.error("Test Failed:", err);
  process.exit(1);
});
