// Disposable drafts only; never sends mail. Removes only IDs created by this run.
import assert from 'node:assert/strict';
import console from 'node:console';
async function call(method, args) {
  const response = await globalThis.fetch('http://127.0.0.1:3000/api/dev-jmap/api', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({using:['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],methodCalls:[[method,args,'test']]}),
  });
  assert.equal(response.status,200);
  const [name,result] = (await response.json()).methodResponses[0];
  assert.equal(name,method);
  return result;
}
const ids = [];
try {
  for (const html of [false,true]) {
    const draft = {
      mailboxIds:{'mb-drafts':true}, keywords:{$draft:true,$seen:true}, subject:'Memail disposable draft regression',
      from:[{name:'Demo',email:'dev@localhost'}], to:[{name:'Synthetic',email:'recipient@example.test'}],
      bcc:[{name:'Synthetic Bcc',email:'bcc@example.test'}], inReplyTo:['original@example.test'], references:['original@example.test'],
      textBody:[{partId:'text'}], bodyValues:{text:{value:'Draft survives reopening. café'}},
      ...(html ? {htmlBody:[{partId:'html',type:'text/html'}]} : {}),
    };
    if (html) draft.bodyValues.html = {value:'<p>Draft <strong>survives</strong> reopening. café</p>'};
    const created = await call('Email/set',{create:{draft}});
    assert.ok(created.created?.draft?.id);
    const id = created.created.draft.id; ids.push(id);
    const result = await call('Email/get',{ids:[id],fetchAllBodyValues:true});
    const restored = result.list[0];
    assert.deepEqual(restored.bodyValues,draft.bodyValues);
    assert.equal(restored.textBody[0].partId,'text');
    assert.equal(restored.textBody[0].type,'text/plain');
    assert.equal(restored.textBody[0].size,new globalThis.TextEncoder().encode(draft.bodyValues.text.value).length);
    assert.equal(restored.htmlBody.length,html ? 1 : 0);
    assert.deepEqual(restored.bcc,draft.bcc);
    assert.deepEqual(restored.inReplyTo,draft.inReplyTo);
    assert.deepEqual(restored.references,draft.references);
  }
  console.log('HTTP demo: plain/HTML draft body, Bcc and reply headers survive create/get.');
} finally {
  if (ids.length) await call('Email/set',{destroy:ids});
}
