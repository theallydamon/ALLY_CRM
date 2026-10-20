const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../task-files.js'),'utf8');
function setup(overrides={}){
 let options, requested=0, calls=[];
 const oauth={initCodeClient(opts){options=opts;return {requestCode(){requested++;queueMicrotask(()=>opts.callback({code:'test-code'}))}}}};
 const sandbox={window:{google:{accounts:{oauth2:oauth}},firebase:{auth:()=>({currentUser:{email:overrides.email||'owner@example.com',getIdToken:async()=> 'firebase-id'}})}},google:{accounts:{oauth2:oauth}},Set,Date:overrides.Date||Date,Promise,Error,Number,String,URL,encodeURIComponent,AbortController,
  fetch:async(url,options)=>{
   calls.push({url,options});
   if(url.includes('workers.dev/drive')) {
    assert.equal(options.headers.Authorization,'Bearer firebase-id');
    assert.equal(options.headers['X-Requested-With'],'AllyCRM');
    return overrides.server ? overrides.server(url,options) : {ok:true,json:async()=>({connected:true,access_token:'test-token',expires_in:3600})};
   }
   return overrides.fetch ? overrides.fetch(url,options) : {ok:true,json:async()=>({files:[]})};
  }
 };
 vm.runInNewContext(source,sandbox);
 return {api:sandbox.window.TaskFiles,calls,oauth,get options(){return options},get requested(){return requested}};
}
test('first approval uses the offline code flow and account-bound CRM authentication',async()=>{
 const ctx=setup();assert.equal(ctx.calls.length,0);assert.equal(ctx.api.token('owner@example.com'),null);
 await ctx.api.connect('owner@example.com','client');
 assert(ctx.options.scope.includes('drive.file'));assert(!ctx.options.scope.split(' ').includes('https://www.googleapis.com/auth/drive'));
 assert.equal(ctx.options.hint,'owner@example.com');assert.equal(ctx.requested,1);
 assert.equal(JSON.parse(ctx.calls[0].options.body).code,'test-code');
 assert.equal(ctx.api.token('owner@example.com'),'test-token');assert.equal(ctx.api.token('other@example.com'),null);
 ctx.api.reset();assert.equal(ctx.api.token('owner@example.com'),null);
});
test('reopening restores Drive without a Google popup or browser token storage',async()=>{
 const first=setup();await first.api.connect('owner@example.com','client');
 const reopened=setup();await reopened.api.restore('owner@example.com');
 assert.equal(reopened.requested,0);assert.equal(reopened.api.connected('owner@example.com'),true);
 assert.equal(reopened.api.token('owner@example.com'),'test-token');
 assert(reopened.calls[0].url.endsWith('/drive/token'));
});
test('expired access renews automatically and concurrent requests share renewal',async()=>{
 let now=Date.now();class Clock extends Date { static now(){return now} }
 const ctx=setup({Date:Clock});await ctx.api.connect('owner@example.com','client');now+=3600000;
 assert.equal(ctx.api.token('owner@example.com'),null);assert.equal(ctx.api.connected('owner@example.com'),true);
 await Promise.all([ctx.api.ensure('owner@example.com'),ctx.api.ensure('owner@example.com')]);
 assert.equal(ctx.calls.filter(c=>c.url.endsWith('/token')).length,1);assert.equal(ctx.requested,1);
});
test('account changes discard in-flight restoration and rejected grants stay disconnected',async()=>{
 let finish;const ctx=setup({server:()=>new Promise(r=>finish=r)});
 const pending=ctx.api.restore('owner@example.com');await new Promise(r=>setImmediate(r));ctx.api.reset();
 finish({ok:true,json:async()=>({connected:true,access_token:'old-account-token',expires_in:3600})});await pending;
 assert.equal(ctx.api.connected('owner@example.com'),false);assert.equal(ctx.api.token('owner@example.com'),null);
 const denied=setup({server:async()=>({ok:false,json:async()=>({error:'Drive permission was not granted.'})})});
 await assert.rejects(denied.api.connect('owner@example.com','client'),/not granted/);
 await assert.rejects(denied.api.connect('wrong@example.com','client'),/Sign in/);
 assert.equal(denied.api.connected('owner@example.com'),false);
});
test('temporary restore failures offer retry without requesting another approval',async()=>{
 let offline=true;
 const ctx=setup({server:async()=>{
  if(offline)throw new Error('Network unavailable');
  return {ok:true,json:async()=>({connected:true,access_token:'restored-token',expires_in:3600})};
 }});
 await assert.rejects(ctx.api.restore('owner@example.com'),/Network/);
 assert.equal(ctx.api.needsRetry('owner@example.com'),true);
 offline=false;await ctx.api.restore('owner@example.com');
 assert.equal(ctx.api.needsRetry('owner@example.com'),false);assert.equal(ctx.requested,0);
 assert.equal(ctx.api.token('owner@example.com'),'restored-token');
});
test('upload uses a private app folder and only returns confirmed file metadata',async()=>{
 const ctx=setup({fetch:async(url,opts)=>{
  if(url.includes('userinfo'))return {ok:true,json:async()=>({email:'owner@example.com',email_verified:true})};
  if(url.includes('?q='))return {ok:true,json:async()=>({files:[{id:'folder_1'}]})};
  if(url.includes('uploadType=resumable')){assert.deepEqual(JSON.parse(opts.body).parents,['folder_1']);assert.equal(JSON.parse(opts.body).appProperties.allyCrmTask,'task-1');return {ok:true,headers:{get:()=> 'https://www.googleapis.com/upload/session-1'}};}
  assert.equal(opts.method,'PUT');return {ok:true,json:async()=>({id:'file_1',name:'document.pdf',mimeType:'application/pdf',size:'32'})};
 }});
 await ctx.api.connect('owner@example.com','client');const result=await ctx.api.upload({name:'document.pdf',type:'application/pdf',size:32},'task-1','owner@example.com');
 assert.equal(result.id,'file_1');assert.equal(result.owner,'owner@example.com');assert.equal(result.size,32);assert(!ctx.calls.some(x=>x.url.includes('permissions')));
});
test('oversized files fail before any network call',async()=>{
 const ctx=setup();await assert.rejects(ctx.api.upload({size:26*1024*1024},'task','owner@example.com'),/25 MB/);assert.equal(ctx.calls.length,0);
});
test('failed uploads and untrusted resumable URLs never return an attachment',async()=>{
 for(const badUrl of [false,'https://untrusted.example/upload']){
  const ctx=setup({fetch:async(url)=>{
   if(url.includes('userinfo'))return {ok:true,json:async()=>({email:'owner@example.com',email_verified:true})};
   if(url.includes('?q='))return {ok:true,json:async()=>({files:[{id:'folder'}]})};
   if(!badUrl)return {ok:false,status:403};
   return {ok:true,headers:{get:()=>badUrl}};
  }});
  await ctx.api.connect('owner@example.com','client');await assert.rejects(ctx.api.upload({size:1,name:'x.txt'},'task','owner@example.com'),/Drive/);
  assert(!ctx.calls.some(x=>x.url.startsWith('https://untrusted')));
 }
});
test('ordinary CRM edits preserve Markdown and attachment metadata',()=>{
 const {saveRecord,version}=require('../functions/crm-records.js');
 const description='| Item | Notes |\n| --- | --- |\n| Document | Keep with task |';
 const record={id:'task',title:'Sample task',description,priority:'Medium',status:'To do',attachments:[{id:'file_1',name:'document.pdf',owner:'owner@example.com'}]};
 const workspace={ally:{lifeAdmin:{items:[record]}}};
 const saved=saveRecord(workspace,{board:'lifeAdmin',id:'task',expectedVersion:version(record),fields:{priority:'High'}});
 assert.equal(saved.result.record.description,description);assert.deepEqual(saved.result.record.attachments,record.attachments);
});
