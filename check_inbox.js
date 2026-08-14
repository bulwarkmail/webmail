const url = 'https://mail.vthul-it.nl/jmap/';

const authF = 'Basic ' + Buffer.from('Michael@vthul-it.nl:Mikey1994LP2026').toString('base64');

async function checkInbox(accountId, name) {
    console.log(`Checking inbox for ${name} (${accountId})...`);
    
    // First, find the Inbox mailbox ID
    const mbReq = {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [
            ["Mailbox/query", { accountId, filter: { role: "inbox" } }, "0"],
            ["Mailbox/get", { accountId, "#ids": { resultOf: "0", name: "Mailbox/query", path: "/ids" } }, "1"]
        ]
    };
    
    const mbRes = await fetch(url, { method: 'POST', headers: { 'Authorization': authF, 'Content-Type': 'application/json' }, body: JSON.stringify(mbReq) });
    const mbData = await mbRes.json();
    const inboxId = mbData.methodResponses[1][1].list[0].id;
    
    const req = {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [
            ["Email/query", { accountId, filter: { inMailbox: inboxId }, sort: [{ property: "receivedAt", isAscending: false }] }, "0"],
            ["Email/get", { accountId, "#ids": { resultOf: "0", name: "Email/query", path: "/ids" }, properties: ["subject", "receivedAt"] }, "1"]
        ]
    };
    
    const res = await fetch(url, { method: 'POST', headers: { 'Authorization': authF, 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    const data = await res.json();
    
    if (data.methodResponses && data.methodResponses[1]) {
        const emails = data.methodResponses[1][1].list;
        for (const email of emails) {
            console.log(`- [${email.receivedAt}] ${email.subject}`);
        }
    } else {
        console.log(`[ERROR] `, JSON.stringify(data, null, 2));
    }
}

async function run() {
    const args = process.argv.slice(2);
    const account = args[0] || 'q';
    await checkInbox(account, account);
}
run();
