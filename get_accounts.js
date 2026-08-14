const url = 'https://mail.vthul-it.nl/jmap/';
const auth = 'Basic ' + Buffer.from('Michael@vthul-it.nl:Mikey1994LP2026').toString('base64');

async function getSession() {
    const res = await fetch('https://mail.vthul-it.nl/.well-known/jmap', {
        method: 'GET',
        headers: { 'Authorization': auth }
    });
    const session = await res.json();
    console.log(JSON.stringify(session.accounts, null, 2));
}

getSession();
