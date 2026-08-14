const url = 'https://mail.vthul-it.nl/jmap/';
const auth = 'Basic ' + Buffer.from('Michael@vthul-it.nl:Mikey1994LP2026').toString('base64');

async function run() {
    const req = {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
        methodCalls: [
            ["CalendarEvent/query", { accountId: "f", filter: {} }, "0"],
            ["CalendarEvent/get", { accountId: "f", "#ids": { resultOf: "0", name: "CalendarEvent/query", path: "/ids" } }, "1"]
        ]
    };
    
    const res = await fetch(url, { method: 'POST', headers: { 'Authorization': auth, 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    const data = await res.json();
    const events = data.methodResponses[1][1].list;
    
    const toDelete = events.filter(e => e.title && (e.title.includes('Scenario 1') || e.title.includes('Scenario 2') || e.title.includes('Scenario 5') || e.title.includes('External Test')));
    
    console.log("Deleting:", toDelete.map(e => e.title));
    const destroyIds = toDelete.map(e => e.id);
    
    if (destroyIds.length > 0) {
        const destroyReq = {
            using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
            methodCalls: [
                ["CalendarEvent/set", { accountId: "f", destroy: destroyIds }, "0"]
            ]
        };
        const destroyRes = await fetch(url, { method: 'POST', headers: { 'Authorization': auth, 'Content-Type': 'application/json' }, body: JSON.stringify(destroyReq) });
        console.log(await destroyRes.json());
    }
}
run();
