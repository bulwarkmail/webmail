const url = 'https://mail.vthul-it.nl/.well-known/jmap';
const auth = 'Basic ' + Buffer.from('Michael@vthul-it.nl:Mikey1994LP2026').toString('base64');

async function getAccounts() {
    const res = await fetch(url, { headers: { 'Authorization': auth, 'Content-Type': 'application/json' }});
    const session = await res.json();
    for (const [id, acc] of Object.entries(session.accounts)) {
        console.log(`${id}: ${acc.name}`);
    }
}
getAccounts();
