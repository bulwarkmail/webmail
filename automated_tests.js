const url = 'https://mail.vthul-it.nl/jmap/';
const authF = 'Basic ' + Buffer.from('Michael@vthul-it.nl:Mikey1994LP2026').toString('base64');
const crypto = require('crypto');

// Map of account aliases to IDs
const accounts = {
    'michael@vthul-it.nl': 'f',
    'beheerder@vthul-it.nl': 'q',
    'test@vthul-it.nl': 'r',
    'testgroup@vthul-it.nl': 'p'
};

async function createEvent(organizerEmail, attendeeEmail) {
    const organizerId = accounts[organizerEmail];
    
    // First find the default calendar for the organizer
    const calReq = {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
        methodCalls: [
            ["Calendar/query", { accountId: organizerId, filter: {} }, "0"],
            ["Calendar/get", { accountId: organizerId, "#ids": { resultOf: "0", name: "Calendar/query", path: "/ids" } }, "1"]
        ]
    };
    
    const calRes = await fetch(url, { method: 'POST', headers: { 'Authorization': authF, 'Content-Type': 'application/json' }, body: JSON.stringify(calReq) });
    const calData = await calRes.json();
    const calendars = calData.methodResponses[1][1].list;
    const defaultCalId = calendars[0].id; // Just use the first one
    
    const eventId = crypto.randomUUID();
    const uid = crypto.randomUUID();
    
    // Schedule 1 day in the future to ensure it passes the event_range_end() > now() check
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Format as LocalDateTime: YYYY-MM-DDThh:mm:ss
    const pad = (n) => n.toString().padStart(2, '0');
    const startStr = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth()+1)}-${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:${pad(tomorrow.getMinutes())}:${pad(tomorrow.getSeconds())}`;
    
    const req = {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
        methodCalls: [
            ["CalendarEvent/set", {
                accountId: organizerId,
                create: {
                    [eventId]: {
                        "@type": "jscalendar",
                        uid: uid,
                        title: `Automated Test: ${organizerEmail} to ${attendeeEmail}`,
                        start: startStr,
                        duration: "PT1H",
                        timeZone: "Europe/Amsterdam",
                        calendarIds: { [defaultCalId]: true },
                        organizerCalendarAddress: `mailto:${organizerEmail}`,
                        replyTo: {
                            [`mailto:${organizerEmail}`]: { "@type": "Link" }
                        },
                        participants: {
                            [crypto.randomUUID()]: {
                                "@type": "Participant",
                                name: organizerEmail.split('@')[0],
                                email: organizerEmail,
                                calendarAddress: `mailto:${organizerEmail}`,
                                roles: { owner: true },
                                participationStatus: "accepted",
                                scheduleAgent: "server"
                            },
                            [crypto.randomUUID()]: {
                                "@type": "Participant",
                                name: attendeeEmail.split('@')[0],
                                email: attendeeEmail,
                                calendarAddress: `mailto:${attendeeEmail}`,
                                roles: { attendee: true },
                                participationStatus: "needs-action",
                                expectReply: true,
                                scheduleAgent: "server"
                            }
                        },
                        privacy: "public",
                        status: "confirmed"
                    }
                },
                sendSchedulingMessages: true
            }, "0"]
        ]
    };
    
    console.log(`\n--- Creating Event from ${organizerEmail} to ${attendeeEmail} ---`);
    const res = await fetch(url, { method: 'POST', headers: { 'Authorization': authF, 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    const data = await res.json();
    console.log(`Event created: ${uid}`);
    return uid;
}

async function run() {
    // A: Internal to Internal
    await createEvent('michael@vthul-it.nl', 'beheerder@vthul-it.nl');
    
    // B: Internal to External
    await createEvent('michael@vthul-it.nl', 'michaelvthul@hotmail.com');
    
    // C: Shared to Internal
    await createEvent('testgroup@vthul-it.nl', 'michael@vthul-it.nl');
    
    // D: Shared to External
    await createEvent('testgroup@vthul-it.nl', 'michaelvthul@hotmail.com');
    
    // E: Internal to Shared
    await createEvent('michael@vthul-it.nl', 'testgroup@vthul-it.nl');
}

run();
