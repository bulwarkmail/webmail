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
                        title: scenarioName + " (Server Scheduling)",
                        start: now.toISOString(),
                        duration: "PT1H",
                        timeZone: "Europe/Amsterdam",
                        calendarIds: { "b": true },
                        replyTo: {
                            "mailto:michael@vthul-it.nl": { "@type": "Link" }
                        },
                        participants: {
                            "michael_part": {
                                "@type": "Participant",
                                name: "Michael",
                                email: "Michael@vthul-it.nl",
                                sendTo: { "imip:michael@vthul-it.nl": { "@type": "Link" } },
                                roles: ["owner", "attendee"],
                                participationStatus: "accepted",
                                scheduleAgent: "server"
                            },
                            "target_part": {
                                "@type": "Participant",
                                name: targetName,
                                email: targetEmail,
                                sendTo: { ["imip:" + targetEmail]: { "@type": "Link" } },
                                roles: ["attendee"],
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
    await runScenario("Scenario 1 Fix", "beheerder@vthul-it.nl", "Beheerder");
}
run();
