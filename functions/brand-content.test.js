const {test}=require('node:test');
const assert=require('node:assert/strict');
const bc=require('./brand-content');
const core=require('./crm-records');
const finance=require('./brand-finance');
const base=()=>({brandContent:{items:[]},deals:{deals:[],clients:[]}});
test('migration preserves scripts, distinct captions, task metadata, finances and is idempotent',()=>{
 const a=base();a.deals.deals=[{id:'d',brand:'Brand',sourceKey:'chat:campaign:x:deal',script:'legacy script',caption:'legacy caption',tasks:[{id:'t',title:'Script',kind:'content',description:'task script',due:'2026-11-01'}],commercial:{stage:'negotiating',fee:100},notes:'admin'}];
 a.brandContent.items=[{id:'c',title:'Existing script',sourceKey:'chat:campaign:x:content',desc:'existing script',caption:'existing caption',attachments:[{id:'file'}],status:'Posted'}];
 const b=bc.migrate(a);
 assert.equal(b.brandContent.items.length,3);
 assert.deepEqual(b.brandContent.items.map(i=>i.desc).sort(),['existing script','legacy script','task script'].sort());
 assert.equal(b.deals.deals[0].tasks[0].due,'2026-11-01');
 assert.equal(b.deals.deals[0].tasks[0].description,undefined);
 assert.deepEqual(b.deals.deals[0].commercial,a.deals.deals[0].commercial);
 assert.deepEqual(b.brandContent.items[0].attachments,[{id:'file'}]);
 assert.equal(bc.migrate(b),b);
 const updated=bc.update(b,'c',{title:'Edited',desc:'New script',caption:'New caption'});
 assert.equal(updated.brandContent.items.length,3);
 assert.equal(updated.brandContent.items[0].desc,'New script');
 assert.throws(()=>bc.update(b,'missing',{desc:'no'}));
});
test('exact task script links to existing content, identical titles do not merge unrelated campaigns',()=>{
 const a=base();a.deals.deals=[{id:'d',brand:'Same',sourceKey:'chat:campaign:a:deal',tasks:[{id:'t',title:'Reel',description:'script'}]}];
 a.brandContent.items=[{id:'c',title:'Same',sourceKey:'chat:campaign:a:content',desc:'script'},{id:'other',title:'Same',sourceKey:'chat:campaign:b:content',desc:'other'}];
 const b=bc.migrate(a);assert.equal(b.brandContent.items.length,2);assert.equal(b.deals.deals[0].tasks[0].contentId,'c');assert.equal(b.brandContent.items[1].dealId,undefined);
});
test('caption-only conflicts preserve both records and exact captions',()=>{
 const a=base();a.deals.deals=[{id:'d',brand:'Brand',sourceKey:'x:deal',caption:'second'}];a.brandContent.items=[{id:'c',sourceKey:'x:content',desc:'script',caption:'first'}];
 const b=bc.migrate(a);assert.deepEqual(b.brandContent.items.map(i=>i.caption),['first','second']);assert.equal(bc.migrate(b),b);
});
test('connector validates links and edits the canonical caption and script without stale copies',()=>{
 const a=base();a.deals.deals=[{id:'d',brand:'Brand',sourceKey:'x:deal',script:'script',caption:'caption'}];a.brandContent.items=[{id:'c',sourceKey:'x:content',desc:'script',title:'Reel'}];
 let w={ally:bc.migrate(a)};const d=w.ally.deals.deals[0];
 const edited=core.saveRecord(w,{board:'deals',id:'d',expectedVersion:core.version(d),fields:{script:'new script',caption:'new caption'}});
 assert.equal(edited.workspace.ally.brandContent.items[0].desc,'new script');assert.equal(edited.workspace.ally.brandContent.items[0].caption,'new caption');assert.equal(edited.result.record.script,'');
 const c=edited.workspace.ally.brandContent.items[0];
 const saved=core.saveRecord(edited.workspace,{board:'brandContent',id:'c',expectedVersion:core.version(c),fields:{caption:'updated'}});
 assert.equal(saved.result.record.caption,'updated');assert.equal(saved.workspace.ally.brandContent.items.length,1);
 assert.throws(()=>core.saveRecord(w,{board:'brandContent',fields:{title:'Oops',dealId:'missing',sourceKey:'x'}}));
});
test('one pipeline taxonomy derives status without overwriting commercial or payment evidence',()=>{
 const make=(stage,extra={})=>({commercial:{stage,reviewed:true,fee:100,currency:'ZAR',...extra}});
 const fixtures=[['proposed',make('proposed')],['negotiating',make('negotiating')],['contracted',make('contracted')],['awaiting_invoice',make('contracted',{paymentStatus:'outstanding',paymentEvidence:'Owner'})],['invoiced',make('contracted',{billingStatus:'invoiced',billingEvidence:'Sent'})],['paid',make('contracted',{paymentStatus:'paid',paymentEvidence:'Owner'})],['barter',make('contracted',{fee:0,paymentStatus:'barter',paymentEvidence:'Owner'})],['declined',make('declined')],['needs_review',make('custom')]];
 for(const [lane,d] of fixtures){const before=JSON.stringify(d);assert.equal(finance.lane(d),lane);assert.ok(finance.LANES.some(l=>l[0]===lane));assert.equal(JSON.stringify(d),before);}
});
test('HubSpot deal prefixes stay distinct and safely link multiple instalment content pieces',()=>{
 const a=base();a.deals.deals=[{id:'d1',brand:'One',sourceKey:'hubspot:deal:111:deal',tasks:[]},{id:'d2',brand:'Two',sourceKey:'hubspot:deal:222:deal',tasks:[{id:'blank',title:'Story',description:''},{id:'written',title:'Story',description:'written script'}]}];
 a.brandContent.items=[{id:'c',sourceKey:'hubspot:deal:222:content:july-story',desc:'written script',title:'Story'}];
 const b=bc.migrate(a);assert.equal(b.brandContent.items[0].dealId,'d2');assert.equal(b.brandContent.items.length,2);assert.equal(b.deals.deals[1].tasks[1].contentId,'c');assert.equal(bc.migrate(b),b);
});
test('legacy script writes can create a first piece but never guess among multiple pieces',()=>{
 const a=base();a.deals.deals=[{id:'d',brand:'Brand',script:'',caption:''}];let w={ally:bc.migrate(a)};
 let result=core.saveRecord(w,{board:'deals',id:'d',expectedVersion:core.version(w.ally.deals.deals[0]),fields:{script:'first'}});
 assert.equal(result.workspace.ally.brandContent.items.length,1);assert.equal(result.workspace.ally.brandContent.items[0].desc,'first');
 const ambiguous={...result.workspace,ally:{...result.workspace.ally,brandContent:{items:[...result.workspace.ally.brandContent.items,{id:'other',dealId:'d',desc:'other'}]},deals:{deals:[{...result.result.record,primaryContentId:''}]}}};
 assert.throws(()=>core.saveRecord(ambiguous,{board:'deals',id:'d',expectedVersion:core.version(ambiguous.ally.deals.deals[0]),fields:{script:'ambiguous'}}),/specific brandContent/);
});

test('active and completed views preserve searchable history and independent delivery/payment states',()=>{
 const content=require('./brand-content');
 const state={deals:{deals:[{id:'a',brand:'Brand',commercial:{paymentStatus:'outstanding'}},{id:'b',brand:'Archived',archived:true}]},brandContent:{items:[{id:'1',dealId:'a',title:'Current',status:'To Film',desc:'New script'},{id:'2',dealId:'a',title:'Old',status:'Posted',desc:'Original skit'},{id:'3',dealId:'b',title:'Retained',status:'Ideas',desc:'Saved'}]}};
 const before=JSON.stringify(state);
 assert.deepEqual(content.groups(state,'','active').flatMap(g=>g.items.map(i=>i.id)),['1']);
 assert.deepEqual(content.groups(state,'','completed').flatMap(g=>g.items.map(i=>i.id)),['2','3']);
 assert.equal(content.groups(state,'Original','completed')[0].items[0].desc,'Original skit');
 assert.equal(content.groups(state,'','all').flatMap(g=>g.items).length,3);
 assert.equal(JSON.stringify(state),before);
});
