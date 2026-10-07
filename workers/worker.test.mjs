import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHandler } from './worker.mjs';
import { decode, encode, verifyIdentity, Workspace } from './firebase.mjs';
import { Store, sha256, seal, unseal } from './store.mjs';
import { callRecord } from './records.mjs';
const BASE='https://ally-crm-connector.theallydamon.workers.dev';
const CALLBACK='https://chatgpt.com/connector_platform_oauth_redirect';
function sqliteD1() {
  const sql=new DatabaseSync(':memory:'); sql.exec(readFileSync(new URL('./migrations/0001_auth.sql',import.meta.url),'utf8'));
  const statement=(query,values=[])=>({bind(...next){return statement(query,next);},async first(){return sql.prepare(query).get(...values)||null;},async run(){const result=sql.prepare(query).run(...values);return {success:true,meta:{changes:result.changes}};}});
  return {sql,prepare:statement,async batch(statements){sql.exec('BEGIN');try{const results=[];for(const st of statements)results.push(await st.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
}
function jwt(email='theallydamon@gmail.com',uid='owner',changes={}) {
  const now=Math.floor(Date.now()/1000);
  return 'header.'+Buffer.from(JSON.stringify({aud:'ally-crm-cbdd1',iss:'https://securetoken.google.com/ally-crm-cbdd1',sub:uid,email,exp:now+3600,auth_time:now-10,...changes})).toString('base64url')+'.fixture-only';
}
function harness() {
  const db=sqliteD1(),env={AUTH_DB:db,CONNECTION_KEY:Buffer.alloc(32,7).toString('base64'),FIREBASE_PROJECT:'ally-crm-cbdd1',FIREBASE_API_KEY:'fixture-key',PUBLIC_ORIGIN:BASE};
  let revision=0,writes=0,conflicts=0,revokeGoogle=false;
  const docs=new Map([
    ['workspaces/ally-crm',{fields:encode({ally:{lifeAdmin:{items:[]},content:{items:[]},brandContent:{items:[]},musicContent:{items:[]},deals:{deals:[]}},mama:{tasks:[]},manualField:{timestampValueAsText:'preserve me'}}).mapValue.fields,updateTime:'revision0'}],
    ['users/owner',{fields:encode({legacySettings:'keep me'}).mapValue.fields,updateTime:'revision0'}]
  ]);
  const respond=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  const fetcher=async (url,init={})=>{
    url=new URL(url);
    if(url.hostname==='securetoken.googleapis.com') {
      if(revokeGoogle)return respond({error:{message:'TOKEN_EXPIRED'}},400);
      const refresh=new URLSearchParams(init.body).get('refresh_token');
      if(refresh==='other-user')return respond({id_token:jwt('ally@mama.co.za','other'),refresh_token:'other-user',project_id:'139362174943'});
      if(refresh!=='fixture-refresh')return respond({error:{}},400);
      return respond({id_token:jwt(),refresh_token:'fixture-refresh',project_id:'139362174943'});
    }
    if(url.hostname==='identitytoolkit.googleapis.com') {
      const token=JSON.parse(init.body).idToken;
      if(token==='invalid')return respond({error:{}},400);
      const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
      return respond({users:[{localId:claims.sub,email:claims.email,emailVerified:true,validSince:0}]});
    }
    assert.equal(url.hostname,'firestore.googleapis.com');
    assert.match(init.headers.authorization,/^Bearer /);
    if(url.pathname.endsWith('documents:commit')) {
      const pending=JSON.parse(init.body).writes;
      if(conflicts>0){conflicts--;return respond({error:{status:'FAILED_PRECONDITION'}},400);}
      for(const write of pending){const key=write.update.name.split('/documents/')[1];if(docs.get(key)?.updateTime!==write.currentDocument.updateTime)return respond({error:{status:'FAILED_PRECONDITION'}},400);}
      revision++;writes++;
      for(const write of pending){const key=write.update.name.split('/documents/')[1];const fields=write.updateMask?{...docs.get(key).fields,...write.update.fields}:write.update.fields;docs.set(key,{fields,updateTime:'revision'+revision});}
      return respond({commitTime:'revision'+revision,writeResults:pending.map(()=>({updateTime:'revision'+revision}))});
    }
    const key=url.pathname.split('/documents/')[1];
    return docs.has(key)?respond(docs.get(key)):respond({error:{status:'NOT_FOUND'}},404);
  };
  const handler=createHandler(fetcher);
  async function request(path,{method='POST',body,token,headers={}}={}) {
    const response=await handler(new Request(BASE+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})}),env);
    const content=await response.text(); let result;try{result=JSON.parse(content);}catch{result=content;}
    return {status:response.status,body:result,headers:response.headers};
  }
  const rpc=(method,params,token)=>request('/mcp',{body:{jsonrpc:'2.0',id:1,method,params},token});
  return {db,env,docs,fetcher,request,rpc,get writes(){return writes;},set conflicts(value){conflicts=value;},set revokeGoogle(value){revokeGoogle=value;}};
}
async function login(h,scope='crm.records.read crm.records.write offline_access',exchangeNow=true) {
  const registration=await h.request('/oauth/register',{body:{redirect_uris:[CALLBACK],client_name:'Fixture'}});assert.equal(registration.status,201);const client=registration.body;
  const verifier='abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',challenge=Buffer.from(sha256(verifier),'hex').toString('base64url');
  const q=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:CALLBACK,code_challenge:challenge,code_challenge_method:'S256',scope,resource:BASE+'/mcp',state:'fixture-state'});
  const authorization=await h.request('/oauth/authorize?'+q,{method:'GET'});assert.equal(authorization.status,200);assert.match(authorization.body,/encrypted Firebase/);
  const row=h.db.sql.prepare("SELECT key FROM auth_state WHERE key LIKE 'pending:%' AND consumed=0").get();const pendingId=row.key.slice(8);
  const approval=await h.request('/oauth/approve',{body:{pendingId,idToken:jwt(),refreshToken:'fixture-refresh'}});assert.equal(approval.status,200);
  const redirect=new URL(approval.body.redirect);assert.equal(redirect.searchParams.get('iss'),BASE);assert.equal(redirect.searchParams.get('state'),'fixture-state');
  const exchange={grant_type:'authorization_code',client_id:client.client_id,client_secret:client.client_secret,redirect_uri:CALLBACK,code:redirect.searchParams.get('code'),code_verifier:verifier,resource:BASE+'/mcp'};
  if (!exchangeNow) return {client,exchange,pendingId};
  const token=await h.request('/oauth/token',{body:exchange});assert.equal(token.status,200);
  return {token:token.body.access_token,refresh:token.body.refresh_token,client,exchange,pendingId};
}
const saveArgs=(requestId='request1',sourceKey='chat:courier')=>({board:'lifeAdmin',requestId,fields:{title:'Call courier',sourceKey}});
test('OAuth, encrypted session, discovery, real REST shapes, save/read and replay',async()=>{
  const h=harness(),session=await login(h);
  assert.equal(h.writes,0); // connection consent only reads CRM
  const sqlRows=h.db.sql.prepare('SELECT payload FROM auth_state').all();
  assert.ok(!JSON.stringify(sqlRows).includes('fixture-refresh'));
  const tools=await h.rpc('tools/list',{},session.token);assert.deepEqual(tools.body.result.tools.map(t=>t.name),['searchCrmRecords','getCrmRecord','saveCrmRecord']);
  const saved=await h.rpc('tools/call',{name:'saveCrmRecord',arguments:saveArgs()},session.token);assert.equal(saved.body.result.structuredContent.created,true);assert.equal(h.writes,1);
  const record=saved.body.result.structuredContent.record;
  const read=await h.rpc('tools/call',{name:'getCrmRecord',arguments:{board:'lifeAdmin',id:record.id}},session.token);assert.equal(read.body.result.structuredContent.record.title,'Call courier');
  const replay=await h.rpc('tools/call',{name:'saveCrmRecord',arguments:saveArgs()},session.token);assert.equal(replay.body.result.structuredContent.replayed,true);assert.equal(h.writes,1);
  assert.equal(decode({mapValue:{fields:h.docs.get('users/owner').fields}}).legacySettings,'keep me');
});
test('single-use authorization codes withstand concurrent exchange',async()=>{
  const h=harness(),s=await login(h,undefined,false);const responses=await Promise.all([h.request('/oauth/token',{body:s.exchange}),h.request('/oauth/token',{body:s.exchange})]);assert.equal(responses.filter(r=>r.status===200).length,1);assert.equal(responses.filter(r=>r.body.error==='invalid_grant').length,1);
});
test('refresh rotates once, retains scope, rejects changed resource and secret',async()=>{
  const h=harness(),s=await login(h,'crm.records.read offline_access');
  const input={grant_type:'refresh_token',client_id:s.client.client_id,client_secret:s.client.client_secret,refresh_token:s.refresh,resource:BASE+'/mcp'};
  assert.equal((await h.request('/oauth/token',{body:{...input,resource:'https://attacker.test/mcp'}})).body.error,'invalid_target');
  assert.equal((await h.request('/oauth/token',{body:{...input,client_secret:'wrong'}})).status,401);
  const results=await Promise.all([h.request('/oauth/token',{body:input}),h.request('/oauth/token',{body:input})]);assert.equal(results.filter(r=>r.status===200).length,1);
  assert.equal(results.find(r=>r.status===200).body.scope,'crm.records.read offline_access');
});
test('read-only token cannot write by invoking undiscovered name',async()=>{
  const h=harness(),s=await login(h,'crm.records.read');
  const saved=await h.rpc('tools/call',{name:'saveCrmRecord',arguments:saveArgs()},s.token);assert.equal(saved.body.result.isError,true);assert.equal(h.writes,0);
});
test('revocation invalidates access and refresh for the connection',async()=>{
  const h=harness(),s=await login(h);assert.equal((await h.request('/oauth/revoke',{body:{client_id:s.client.client_id,client_secret:s.client.client_secret,token:s.refresh}})).status,200);
  assert.equal((await h.rpc('tools/list',{},s.token)).status,401);
  assert.equal((await h.request('/oauth/token',{body:{grant_type:'refresh_token',client_id:s.client.client_id,client_secret:s.client.client_secret,refresh_token:s.refresh}})).body.error,'invalid_grant');
});
test('refresh completion cannot resurrect a concurrently revoked session',async()=>{
  const h=harness(),store=new Store(h.db);await store.put('session:one',{credentials:'fixture'},Date.now()+10000);await store.claim('session:one');assert.equal(await store.updateSession('session:one',{credentials:'new'}),false);assert.equal(await store.get('session:one'),null);
});
test('revoked Google credential blocks data access and writes',async()=>{
  const h=harness(),s=await login(h);h.revokeGoogle=true;const result=await h.rpc('tools/call',{name:'saveCrmRecord',arguments:saveArgs()},s.token);assert.equal(result.body.result.isError,true);assert.equal(h.writes,0);
});
test('wrong project, expired identity and unapproved account fail verification',async()=>{
  const h=harness();for(const token of [jwt('unapproved@example.com'),jwt(undefined,undefined,{aud:'other-project'}),jwt(undefined,undefined,{exp:1}),jwt(undefined,undefined,{iss:'https://attacker.test'})])await assert.rejects(verifyIdentity(h.env,token,h.fetcher));
});
test('pending consent is single-use and cannot link a different refresh identity',async()=>{
  const h=harness(),s=await login(h);assert.equal((await h.request('/oauth/approve',{body:{pendingId:s.pendingId,idToken:jwt(),refreshToken:'fixture-refresh'}})).status,400);assert.equal(h.writes,0);
});
test('workspace conflicts retry without duplicate; old versions reject updates',async()=>{
  const h=harness(),workspace=new Workspace(h.env,jwt(),h.fetcher,'owner'),actor={email:'theallydamon@gmail.com'};h.conflicts=1;
  const saved=await callRecord(workspace,'saveCrmRecord',saveArgs(),actor);assert.equal(h.writes,1);
  const args={board:'lifeAdmin',id:saved.record.id,expectedVersion:saved.version,requestId:'update1',fields:{status:'In progress'}};
  await callRecord(workspace,'saveCrmRecord',args,actor);assert.equal(h.writes,2);
  await assert.rejects(callRecord(workspace,'saveCrmRecord',{...args,requestId:'update2'},actor),/Record changed/);assert.equal(h.writes,2);
  await assert.rejects(callRecord(workspace,'saveCrmRecord',{...saveArgs(),fields:{title:'different',sourceKey:'other'}},actor),/different arguments/);
});
test('manual whole-workspace saves cannot erase operation history',async()=>{
  const h=harness(),workspace=new Workspace(h.env,jwt(),h.fetcher,'owner'),actor={email:'theallydamon@gmail.com'};
  const saved=await callRecord(workspace,'saveCrmRecord',saveArgs(),actor);
  const data=decode({mapValue:{fields:h.docs.get('workspaces/ally-crm').fields}});data.ally.lifeAdmin.items[0].title='Manual edit';
  h.docs.set('workspaces/ally-crm',{fields:encode({ally:data.ally,mama:data.mama}).mapValue.fields,updateTime:'manual-edit'});
  const replay=await callRecord(workspace,'saveCrmRecord',saveArgs(),actor);assert.equal(replay.replayed,true);assert.equal(replay.record.id,saved.record.id);assert.equal(replay.record.title,'Manual edit');assert.equal(h.writes,1);
});
test('Firestore codec preserves uncommon types and ordinary marker-like maps',()=>{
  const values=[{timestampValue:'2026-10-07T00:00:00.123456Z'},{integerValue:'9223372036854775807'},{doubleValue:'NaN'},{bytesValue:'aGVsbG8='},{referenceValue:'projects/p/databases/(default)/documents/x/y'},{geoPointValue:{latitude:1,longitude:2}},{mapValue:{fields:{__allyConnectorFirestoreValue:{stringValue:'ordinary'}}}}];
  for(const value of values)assert.deepEqual(encode(decode(value)),value);
});
test('secret encryption is session-bound and fails with wrong key',async()=>{
  const key=Buffer.alloc(32,1).toString('base64'),sealed=await seal(key,{refreshToken:'private'},'session1');assert.deepEqual(await unseal(key,sealed,'session1'),{refreshToken:'private'});await assert.rejects(unseal(key,sealed,'session2'));await assert.rejects(unseal(Buffer.alloc(32,2).toString('base64'),sealed,'session1'));
});
test('transport metadata, origin rejection, missing auth and rate limits',async()=>{
  const h=harness();assert.equal((await h.request('/health',{method:'GET'})).body.version,'3.0.0');assert.equal((await h.request('/.well-known/oauth-authorization-server',{method:'GET'})).body.issuer,BASE);
  assert.equal((await h.request('/mcp',{method:'GET'})).status,405);assert.equal((await h.rpc('tools/list',{},'invalid')).status,401);
  assert.equal((await h.request('/oauth/register',{body:{redirect_uris:[CALLBACK]},headers:{origin:'https://evil.test'}})).status,403);
  const store=new Store(h.db);for(let i=0;i<60;i++)assert.equal(await store.limit('fixture'),true);assert.equal(await store.limit('fixture'),false);
  assert.equal((await h.request('/oauth/register',{body:{redirect_uris:['https://evil.test/callback']}})).status,400);
});
