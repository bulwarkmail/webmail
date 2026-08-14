const url = 'https://mail.vthul-it.nl/jmap/';
const authF = 'Basic ' + Buffer.from('Michael@vthul-it.nl:Mikey1994LP2026').toString('base64');

async function checkIdentity(accountId) {
    const req = {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:submission"],
        methodCalls: [
            ["Identity/get", { accountId }, "0"]
        ]
    };
    const res = await fetch(url, { method: 'POST', headers: { 'Authorization': authF, 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    const data = await res.json();
    console.log(`Identities for ${accountId}:`, JSON.stringify(data.methodResponses[0][1], null, 2));
}

checkIdentity('p'); // testgroup
checkIdentity('f'); // michael
