const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../task-files.js'),'utf8');
function setup(overrides={}){
 let options, requested, calls=[];
 const oauth={
  initTokenClient(opts){options=opts;return {requestAccessToken(input){requested=input;queueMicrotask(()=>opts.callback({access_token:'test-token',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file openid email'}))}}},
  hasGrantedAllScopes(response,scope){return response.scope.split(' ').includes(scope)}
 };
 const sandbox={window:{google:{accounts:{oauth2:oauth}}},google:{accounts:{oauth2:oauth}},Set,Date,Promise,Error,Number,String,URL,encodeURIComponent,AbortController,
  fetch:async(url,options)=>{calls.push({url,options});return overrides.fetch ? overrides.fetch(url,options) : url.includes('userinfo') ? {ok:true,json:async()=>({email:'owner@example.com',email_verified:true})} : {ok:true,json:async()=>({files:[]})}}
 };
 vm.runInNewContext(source,sandbox);
 return {api:sandbox.window.TaskFiles,calls,oauth,get options(){return options},get requested(){return requested}};
}
test('Drive consent is on demand, scoped to files created/selected for this app, and account-bound',async()=>{
 const ctx=setup();assert.equal(ctx.calls.length,0);assert.equal(ctx.api.token('owner@example.com'),null);
 await ctx.api.connect('owner@example.com','client');
 assert(ctx.options.scope.includes('drive.file'));assert(!ctx.options.scope.split(' ').includes('https://www.googleapis.com/auth/drive'));
 assert.equal(ctx.requested.login_hint,'owner@example.com');assert.equal(ctx.api.token('owner@example.com'),'test-token');assert.equal(ctx.api.token('other@example.com'),null);
 ctx.api.reset();assert.equal(ctx.api.token('owner@example.com'),null);
});
test('wrong-account grants and denied scope never create an upload session',async()=>{
 const ctx=setup();await assert.rejects(ctx.api.connect('wrong@example.com','client'),/same Google account/);assert.equal(ctx.api.token('wrong@example.com'),null);
 const denied=setup();denied.oauth.hasGrantedAllScopes=()=>false;await assert.rejects(denied.api.connect('owner@example.com','client'),/not granted/);
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
