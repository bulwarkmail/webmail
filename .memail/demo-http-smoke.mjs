// Run against `node .memail/demo.mjs`; read-only synthetic HTTP integration.
import assert from 'node:assert/strict';
import console from 'node:console';
const inbox = {inMailbox:'mb-inbox'};
const header = {header:['List-Unsubscribe']};
const and = (...conditions) => ({operator:'AND',conditions});
const filters = [inbox, and(inbox,header), and(inbox,{operator:'NOT',conditions:[header]}), and(inbox,{header:['list-unsubscribe','SIDENOTE']}), and(inbox,{minSize:18200,maxSize:18201})];
const response = await globalThis.fetch('http://127.0.0.1:3000/api/dev-jmap/api', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body:JSON.stringify({using:['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],methodCalls:filters.map((filter,i)=>['Email/query',{filter,limit:100},String(i)])}),
});
assert.equal(response.status,200);
const body = await response.json();
const sets = body.methodResponses.map(([method,result]) => { assert.equal(method,'Email/query'); assert.equal(result.total,result.ids.length); return new Set(result.ids); });
assert.equal(sets[1].size,2);
assert.equal(sets[3].size,1);
assert.deepEqual(sets[3],sets[4]);
assert.equal([...sets[1]].some(id=>sets[2].has(id)),false);
assert.deepEqual(new Set([...sets[1],...sets[2]]),sets[0]);
console.log('HTTP demo: header presence/value, NOT partition, size boundaries and totals passed.');
