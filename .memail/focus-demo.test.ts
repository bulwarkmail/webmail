import { describe, expect, it } from 'vitest';
import { DemoJMAPClient } from '../lib/demo/demo-client';
import { buildFocusViews, FOCUS_MODES } from './plugins/focus-inbox/views';

describe('Memail focus views against the real demo client',()=>{
  it.each(FOCUS_MODES)('%s has correct membership and counts without modifying messages',async mode=>{
    const client=new DemoJMAPClient();
    const inbox=(await client.getMailboxes()).find(mailbox=>mailbox.role==='inbox')!;
    const all=await client.getEmails(inbox.id,undefined,1000);
    const before=JSON.stringify(all.emails);
    const tabs=buildFocusViews({focusMode:mode},key=>key)!.tabs;
    const newsletter=(email:typeof all.emails[number])=>Object.keys(email.headers??{}).some(key=>key.toLowerCase()==='list-unsubscribe');
    const expected=[
      all.emails,
      all.emails.filter(email=>!!email.keywords.$flagged || (mode!=='Starred only' && !email.keywords.$seen && (mode==='All unread and starred' || !newsletter(email)))),
      all.emails.filter(newsletter),
    ];
    const counts=await client.getCategoryUnreadCounts(inbox.id,tabs.map(tab=>({id:tab.id,filter:tab.query!})));
    for(const [index,tab] of tabs.entries()) {
      const actual=await client.getEmails(inbox.id,undefined,1000,0,undefined,false,tab.query);
      expect(actual.emails.map(email=>email.id).sort()).toEqual(expected[index].map(email=>email.id).sort());
      expect(counts[tab.id]).toBe(expected[index].filter(email=>!email.keywords.$seen).length);
    }
    expect(JSON.stringify((await client.getEmails(inbox.id,undefined,1000)).emails)).toBe(before);
  });
});
