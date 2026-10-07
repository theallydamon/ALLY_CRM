import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sha256, seal } from './store.mjs';
import { encode } from './firebase.mjs';
const BASE='https://ally-crm-connector.theallydamon.workers.dev';
test('bundled Worker runs crypto, D1, OAuth and authenticated read inside workerd',async()=>{
  const { MockAgent, fetch: mockFetch }=await import('undici');
  const mock=new MockAgent();mock.disableNetConnect();
  const now=Math.floor(Date.now()/1000);
  const token='header.'+Buffer.from(JSON.stringify({aud:'ally-crm-cbdd1',iss:'https://securetoken.google.com/ally-crm-cbdd1',sub:'owner',exp:now+3600,auth_time:now-10})).toString('base64url')+'.fixture-only';
  mock.get('https://securetoken.googleapis.com').intercept({method:'POST',path:/\/v1\/token\?key=/}).reply(200,{id_token:token,refresh_token:'fixture-refresh',project_id:'139362174943'}).persist();
  mock.get('https://identitytoolkit.googleapis.com').intercept({method:'POST',path:/\/v1\/accounts:lookup\?key=/}).reply(200,{users:[{email:'theallydamon@gmail.com',localId:'owner',emailVerified:true,validSince:0}]}).persist();
  mock.get('https://firestore.googleapis.com').intercept({method:'GET',path:'/v1/projects/ally-crm-cbdd1/databases/(default)/documents/workspaces/ally-crm'}).reply(200,{fields:encode({ally:{lifeAdmin:{items:[{id:'fixture',title:'Runtime fixture',sourceKey:'fixture:runtime'}]}},mama:{tasks:[]}}).mapValue.fields,updateTime:'2026-10-07T00:00:00Z'}).persist();
  const key=Buffer.alloc(32,8).toString('base64');
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:new URL('./dist/worker.js',import.meta.url).pathname,compatibilityDate:'2026-10-07',compatibilityFlags:['nodejs_compat'],d1Databases:['AUTH_DB'],bindings:{CONNECTION_KEY:key,FIREBASE_PROJECT:'ally-crm-cbdd1',FIREBASE_API_KEY:'fixture-key',PUBLIC_ORIGIN:BASE},outboundService: async request => { const response = await mockFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: request.body ? Buffer.from(await request.arrayBuffer()) : undefined, dispatcher: mock }); return new Response(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) }); }}));
  try {
    const db=await mf.getD1Database('AUTH_DB');
    const migration=readFileSync(new URL('./migrations/0001_auth.sql',import.meta.url),'utf8');
    for(const statement of migration.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
    const health=await mf.dispatchFetch(BASE+'/health');assert.equal((await health.json()).version,'3.0.0');
    const registration=await mf.dispatchFetch(BASE+'/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect']})});assert.equal(registration.status,201);assert.ok((await registration.json()).client_secret);
    const sessionId='runtime-session',expiry=Date.now()+3600000;
    const session={email:'theallydamon@gmail.com',uid:'owner',expiresAt:expiry,credentials:await seal(key,{refreshToken:'fixture-refresh'},sessionId)};
    const actor={kind:'access',email:session.email,uid:'owner',sessionId,scope:'crm.records.read',resource:BASE+'/mcp',expiresAt:expiry};
    for(const [id,value] of [['session:'+sessionId,session],['token:'+sha256('runtime-access'),actor]])await db.prepare('INSERT INTO auth_state(key,payload,expires) VALUES(?,?,?)').bind(id,JSON.stringify(value),expiry).run();
    const read=await mf.dispatchFetch(BASE+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer runtime-access'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'getCrmRecord',arguments:{board:'lifeAdmin',id:'fixture'}}})});
    const result=await read.json();assert.equal(result.result?.isError,undefined,JSON.stringify(result));assert.equal(result.result.structuredContent.record.title,'Runtime fixture');
  } finally { await mf.dispose();await mock.close(); }
});
