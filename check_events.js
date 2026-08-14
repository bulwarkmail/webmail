const url = 'https://mail.vthul-it.nl/jmap/';
const auth = 'Basic ' + Buffer.from('beheerder@vthul-it.nl:Mikey1994LP2026').toString('base64');

async function checkCalendars(accountId) {
    console.log(`Checking events for ${accountId}...`);
    const req = {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
        methodCalls: [
            ["CalendarEvent/query", { accountId, filter: {} }, "0"],
            ["CalendarEvent/get", { accountId, "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" } }, "1"]
        ]
    };
    
    const res = await fetch(url, { method: 'POST', headers: { 'Authorization': auth, 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    const data = await res.json();
    const events = data.methodResponses[1][1].list;
    if (events && events.length > 0) {
        events.sort((a, b) => {
            const timeA = a.start ? new Date(a.start).getTime() : 0;
            const timeB = b.start ? new Date(b.start).getTime() : 0;
            return timeB - timeA;
        });
        console.log(JSON.stringify(events.slice(0, 5), null, 2));
    } else {
        console.log("- No events found.");
    }
}

async function run() {
    await checkCalendars("q"); // Beheerder's calendar
}
run();
