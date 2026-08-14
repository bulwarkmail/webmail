const url = 'https://mail.vthul-it.nl/jmap/';
const auth = 'Basic ' + Buffer.from('Michael@vthul-it.nl:Mikey1994LP2026').toString('base64');

async function run() {
    // 1. Get Calendars for Michael
    const req1 = {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
        methodCalls: [
            ["Calendar/get", { accountId: "f" }, "0"]
        ]
    };
    
    let res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(req1)
    });
    
    let data = await res.json();
    console.log("Calendars:");
    const calendars = data.methodResponses[0][1].list;
    calendars.forEach(c => console.log(`- ${c.id}: ${c.name} (isDefault: ${c.isDefault})`));
}
run();
