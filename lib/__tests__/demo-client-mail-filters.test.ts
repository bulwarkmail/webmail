import { describe, expect, it } from 'vitest';
import { DemoJMAPClient } from '@/lib/demo/demo-client';

async function query(client: DemoJMAPClient, filter:Record<string,unknown>, limit=1000, position=0) {
  return client.getEmails(undefined,undefined,limit,position,undefined,false,filter);
}
describe('demo header and size filters',()=>{
  it('matches header presence case-insensitively without admitting ordinary mail',async()=>{
    const client=new DemoJMAPClient();
    const all=await client.getEmails(undefined,undefined,1000);
    const expected=all.emails.filter(email=>Object.keys(email.headers??{}).some(name=>name.toLowerCase()==='list-unsubscribe'));
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(all.total);
    const result=await query(client,{header:['lIsT-uNsUbScRiBe']});
    expect(result.emails.map(email=>email.id).sort()).toEqual(expected.map(email=>email.id).sort());
  });
  it('supports header value arrays, empty existing headers and absent headers',async()=>{
    const client=new DemoJMAPClient();
    const email=(await client.getEmails(undefined,undefined,1)).emails[0];
    email.headers={...email.headers,'X-Demo-Filter':['First value','Second Match'],'X-Demo-Empty':''};
    expect((await query(client,{header:['x-demo-filter','SECOND match']})).emails.map(e=>e.id)).toEqual([email.id]);
    expect((await query(client,{header:['X-Demo-Filter','missing']})).total).toBe(0);
    expect((await query(client,{header:['X-Demo-Empty']})).emails.map(e=>e.id)).toEqual([email.id]);
    expect((await query(client,{header:['X-Demo-Not-Present']})).total).toBe(0);
  });
  it.each([{header:[]},{header:['']},{header:['x',42]},{header:['x','y','z']},{header:'x'}])('rejects an invalid header condition: $header',async ({header})=>{
    expect((await query(new DemoJMAPClient(),{header})).total).toBe(0);
  });
  it('uses inclusive minimum and exclusive maximum size bounds',async()=>{
    const client=new DemoJMAPClient();
    const email=(await client.getEmails(undefined,undefined,1)).emails[0];
    email.size=100; email.headers={...email.headers,'X-Demo-Size':'present'};
    const condition={header:['X-Demo-Size']};
    expect((await query(client,{...condition,minSize:100,maxSize:101})).total).toBe(1);
    expect((await query(client,{...condition,minSize:101})).total).toBe(0);
    expect((await query(client,{...condition,maxSize:100})).total).toBe(0);
    expect((await query(client,{minSize:0})).total).toBe((await client.getEmails(undefined,undefined,1000)).total);
  });
  it('preserves total, pagination and unread-count semantics for compound filters',async()=>{
    const client=new DemoJMAPClient();
    const inbox=(await client.getMailboxes()).find(mailbox=>mailbox.role==='inbox')!;
    for (const email of (await client.getEmails(inbox.id,undefined,2)).emails) {
      email.headers={...email.headers,'List-Unsubscribe':'<mailto:leave@example.invalid>'};
      delete email.keywords.$seen;
    }
    const filter={operator:'AND',conditions:[{header:['List-Unsubscribe']},{notKeyword:'$seen'}]};
    const all=await query(client,filter);
    expect(all.total).toBeGreaterThan(1);
    const first=await query(client,filter,1,0);
    const second=await query(client,filter,1,1);
    expect(first.total).toBe(all.total); expect(first.hasMore).toBe(true);
    expect([first.emails[0].id,second.emails[0].id]).toEqual(all.emails.slice(0,2).map(e=>e.id));
    const inInbox=await query(client,{operator:'AND',conditions:[filter,{inMailbox:inbox.id}]});
    expect(await client.getCategoryUnreadCounts(inbox.id,[{id:'newsletter',filter:{header:['List-Unsubscribe']}}])).toEqual({newsletter:inInbox.total});
  });
});
