const url = 'https://mail.vthul-it.nl/jmap/';
const auth = 'Basic ' + Buffer.from('Michael@vthul-it.nl:Mikey1994LP2026').toString('base64');
const crypto = require('crypto');

async function runScenario(scenarioName, targetEmail, targetName) {
    const eventId = crypto.randomUUID();
    const now = new Date();
    
    const req = {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
        methodCalls: [
            ["CalendarEvent/set", {
                accountId: "f", // Michael
                create: {
                    [eventId]: {
                        "@type": "jscalendar",
                        title: scenarioName + " (Server Scheduling Fixed)",
                        start: now.toISOString(),
                        duration: "PT1H",
                        timeZone: "Europe/Amsterdam",
                        calendarIds: { "b": true },
                        organizerCalendarAddress: "mailto:michael@vthul-it.nl",
                        replyTo: { "mailto:michael@vthul-it.nl": { "@type": "Link" } }, // ADDED BACK
                        participants: {
                            "michael_part": {
                                "@type": "Participant",
                                name: "Michael",
                                email: "michael@vthul-it.nl",
                                calendarAddress: "mailto:michael@vthul-it.nl",
                                roles: { owner: true },
                                participationStatus: "accepted",
                                scheduleAgent: "server"
                            },
                            "target_part": {
                                "@type": "Participant",
                                name: targetName,
                                email: targetEmail,
                                calendarAddress: "mailto:" + targetEmail,
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
    
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
    });
    
    const data = await res.json();
    console.log(`Response for ${scenarioName}:`, JSON.stringify(data.methodResponses[0][1], null, 2));
}

async function run() {
    await runScenario("Scenario 1 Fix 4 ReplyTo", "beheerder@vthul-it.nl", "Beheerder");
}
run();
