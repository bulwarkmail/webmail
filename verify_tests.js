const url = 'https://mail.vthul-it.nl/jmap/';
const authF = 'Basic ' + Buffer.from('Michael@vthul-it.nl:Mikey1994LP2026').toString('base64');

const accounts = {
    'michael@vthul-it.nl': 'f',
    'beheerder@vthul-it.nl': 'q',
    'test@vthul-it.nl': 'r',
    'testgroup@vthul-it.nl': 'p'
};

async function checkCalendar(accountId, name) {
    const req = {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
        methodCalls: [
            ["CalendarEvent/query", { accountId, filter: {} }, "0"],
            ["CalendarEvent/get", { accountId, "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" } }, "1"]
        ]
    };
    
    const res = await fetch(url, { method: 'POST', headers: { 'Authorization': authF, 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    const data = await res.json();
    const events = data.methodResponses[1][1].list;
    
    console.log(`\n--- Calendar for ${name} ---`);
    if (events && events.length > 0) {
        const automatedEvents = events.filter(e => e.title && e.title.includes('Automated Test:'));
        if (automatedEvents.length > 0) {
            automatedEvents.forEach(e => {
                console.log(`[SUCCESS] Found event: "${e.title}"`);
                console.log(`          Status: ${e.status}, Start: ${e.start}`);
            });
        } else {
            console.log(`[FAIL] No Automated Test events found.`);
        }
    } else {
        console.log(`[FAIL] No events found.`);
    }
}

async function run() {
    await checkCalendar(accounts['beheerder@vthul-it.nl'], 'Beheerder (Target of Scenario A)');
    await checkCalendar(accounts['michael@vthul-it.nl'], 'Michael (Target of Scenario C)');
    await checkCalendar(accounts['testgroup@vthul-it.nl'], 'TestGroup (Target of Scenario E)');
}

run();
