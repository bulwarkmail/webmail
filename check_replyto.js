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
    console.log(JSON.stringify(events.slice(0, 3).map(e => ({ title: e.title, replyTo: e.replyTo })), null, 2));
}
run();
