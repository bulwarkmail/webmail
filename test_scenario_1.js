const url = 'https://mail.vthul-it.nl/jmap/';
const auth = 'Basic ' + Buffer.from('Michael@vthul-it.nl:Mikey1994LP2026').toString('base64');
const crypto = require('crypto');

async function run() {
    const eventId = crypto.randomUUID();
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    
    const req = {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
        methodCalls: [
            ["CalendarEvent/set", {
                accountId: "f", // Michael
                create: {
                    [eventId]: {
                        "@type": "jscalendar",
                        title: "Scenario 1: P1 -> P2 (Internal)",
                        start: now.toISOString(),
                        duration: "PT1H",
                        timeZone: "Europe/Amsterdam",
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
                                participationStatus: "accepted"
                            },
                            "beheerder_part": {
                                "@type": "Participant",
                                name: "Beheerder",
                                email: "beheerder@vthul-it.nl",
                                sendTo: { "imip:beheerder@vthul-it.nl": { "@type": "Link" } },
                                roles: ["attendee"],
                                participationStatus: "needs-action",
                                expectReply: true
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
    
    console.log("Sending Request to Stalwart...");
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
    });
    
    const data = await res.json();
    console.log("Response:", JSON.stringify(data, null, 2));
}
run();
