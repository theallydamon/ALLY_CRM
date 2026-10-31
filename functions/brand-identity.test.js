const {test}=require('node:test');const assert=require('node:assert/strict');
const identity=require('./brand-identity'),content=require('./brand-content'),core=require('./crm-records');
function fixture(){const commercial={stage:'negotiating',currency:'ZAR',fee:6000,agencyFee:null,tax:null,reviewed:false,paymentStatus:'unknown',billingStatus:'unknown',invoices:[]};return {deals:{deals:[{id:'PApPycnVxBSk',brand:'Go Move',sourceKey:'source:a',notes:'First enquiry',commercial:{...commercial,evidence:'First source'},tasks:[]},{id:'w8rqzIpfy2V-',brand:'GoMove (@gomove_za)',sourceKey:'source:b',sourceUrl:'https://example.com/enquiry',notes:'Original enquiry',commercial:{...commercial,evidence:'Original source'},tasks:[]}]},brandContent:{items:[{id:'-y2Kb_0PEy3c',dealId:'PApPycnVxBSk',title:'Reel',desc:'TBD',caption:'',status:'Ideas',paused:true},{id:'LxkJVwcLzLl9',dealId:'w8rqzIpfy2V-',title:'Other title',desc:'TBD',caption:'',status:'Ideas',paused:true,sourceKey:'content:b',links:[{id:'source',url:'https://example.com/enquiry'}]}]}};}
test('normalized brand identity ignores whitespace, punctuation and handle annotations',()=>{
 for(const name of ['Go Move','GOMOVE','Go-Move','GoMove (@gomove_za)','GoMove @gomove_za'])assert.equal(identity.key(name),'gomove');
 assert.notEqual(identity.key('Go Motion'),identity.key('Go Move'));assert.equal(identity.find([{id:'d',brand:'Renamed',brandAliases:['Go Move']}],'GOMOVE').id,'d');
});
test('reviewed duplicate consolidation preserves complete snapshots, sources and links exactly once',()=>{
 const a=fixture(),b=content.migrate(a);assert.equal(b.deals.deals.length,1);assert.equal(b.brandContent.items.length,1);
 const d=b.deals.deals[0];assert.match(d.notes,/First enquiry/);assert.match(d.notes,/Original enquiry/);assert.match(d.commercial.evidence,/First source/);assert.match(d.commercial.evidence,/Original source/);
 assert.deepEqual(b.deals.mergeHistory[0].before.deals,a.deals.deals);assert.deepEqual(b.deals.mergeHistory[0].before.content,a.brandContent.items);
 assert.ok(d.sourceKeys.includes('source:b'));assert.ok(b.brandContent.items[0].links.some(l=>l.id==='source'));
 assert.equal(identity.resolve(b.deals.aliases,'w8rqzIpfy2V-'),d.id);assert.equal(identity.resolve(b.brandContent.aliases,'LxkJVwcLzLl9'),'-y2Kb_0PEy3c');assert.equal(content.migrate(b),b);
});
test('different creative scripts remain separate pieces under the same brand',()=>{
 const a=fixture();a.brandContent.items[0].desc='Script one';a.brandContent.items[1].desc='Script two';const b=content.migrate(a);
 assert.equal(b.deals.deals.length,1);assert.equal(b.brandContent.items.length,2);assert.ok(b.brandContent.items.every(i=>i.dealId==='PApPycnVxBSk'));
});
test('financial disagreement prevents an unsafe first merge',()=>{
 const a=fixture();a.deals.deals[1].commercial.fee=9000;const b=identity.migrate(a);assert.equal(b.deals.deals.length,2);assert.equal(b.deals.mergeHistory.length,0);
});
test('old links and writes resolve to canonical records with fresh version protection',()=>{
 const w={ally:content.migrate(fixture())},d=core.resolveRecord(w,'deals','w8rqzIpfy2V-');assert.equal(d.id,'PApPycnVxBSk');
 const saved=core.saveRecord(w,{board:'deals',id:'w8rqzIpfy2V-',expectedVersion:core.version(d),fields:{notes:'Updated once'}});
 assert.equal(saved.result.record.id,d.id);assert.equal(saved.result.record.notes,'Updated once');assert.equal(saved.workspace.ally.deals.deals.length,1);
 const c=core.resolveRecord(saved.workspace,'brandContent','LxkJVwcLzLl9');assert.equal(c.id,'-y2Kb_0PEy3c');
 const edited=core.saveRecord(saved.workspace,{board:'brandContent',id:'LxkJVwcLzLl9',expectedVersion:core.version(c),fields:{caption:'Shared caption'}});
 assert.equal(edited.result.record.id,c.id);assert.equal(edited.result.record.caption,'Shared caption');assert.equal(edited.workspace.ally.brandContent.items.length,1);
 assert.throws(()=>core.saveRecord(edited.workspace,{board:'brandContent',id:c.id,expectedVersion:core.version(c),fields:{caption:'Stale'}}),/Record changed/);
});
test('duplicate brands and retired source keys cannot recreate profiles, even with different campaign text',()=>{
 const w={ally:content.migrate(fixture())};
 for(const fields of [{brand:'Go-Move',sourceKey:'entirely:new',commercial:{campaign:'Different campaign'}},{brand:'Different spelling',sourceKey:'source:b'}]){
  const result=core.saveRecord(w,{board:'deals',fields});assert.equal(result.result.duplicate,true);assert.equal(result.result.record.id,'PApPycnVxBSk');assert.equal(result.workspace.ally.deals.deals.length,1);
 }
 const w2={ally:{...w.ally,deals:{...w.ally.deals,deals:[...w.ally.deals.deals,{id:'other',brand:'Other'}]}}};
 assert.throws(()=>core.saveRecord(w2,{board:'deals',id:'other',expectedVersion:core.version(w2.ally.deals.deals[1]),fields:{brand:'Go Move'}}),/already has a profile/);
});
test('stale resurrection cannot restore a second editable profile or overwrite newer canonical edits',()=>{
 const a=fixture(),b=content.migrate(a);b.deals.deals[0].notes='Newer saved note';b.deals.deals.push({...a.deals.deals[1],notes:'Stale client edit'});
 const c=content.migrate(b);assert.equal(c.deals.deals.length,1);assert.equal(c.deals.deals[0].notes,'Newer saved note');assert.equal(c.deals.mergeHistory[0].recoveredRecords[0].notes,'Stale client edit');assert.equal(content.migrate(c),c);
});
test('a retired content record cannot reappear from an older tab independently of its deal',()=>{
 const a=fixture(),b=content.migrate(a);b.brandContent.items.push({...a.brandContent.items[1],desc:'Old-tab script edit'});
 const c=content.migrate(b);assert.equal(c.brandContent.items.length,1);assert.equal(c.deals.mergeHistory[0].recoveredContent[0].desc,'Old-tab script edit');assert.equal(content.migrate(c),c);
});
test('independent new-brand creates choose the same stable ID across name variations',()=>{
 const workspace={ally:{deals:{deals:[]},brandContent:{items:[]}}};
 const a=core.saveRecord(workspace,{board:'deals',fields:{brand:'A New Brand',sourceKey:'new:a'}});
 const b=core.saveRecord(workspace,{board:'deals',fields:{brand:'a-new-brand',sourceKey:'new:b'}});
 assert.equal(a.result.record.id,b.result.record.id);assert.equal(a.result.record.id,'brand-anewbrand');
});
test('open editors absorb remote changes while preserving disjoint local edits and detect same-field conflicts',()=>{
 const base={brand:'Go Move',commercial:{fee:6000,contact:'Original'}},draft={...base,commercial:{...base.commercial,fee:6100}},live={...base,brand:'GoMove',commercial:{...base.commercial,contact:'Updated'}};
 const result=identity.rebase(base,draft,live);assert.equal(result.draft.brand,'GoMove');assert.equal(result.draft.commercial.fee,6100);assert.equal(result.draft.commercial.contact,'Updated');assert.deepEqual(result.conflicts,[]);
 const conflict=identity.rebase(base,draft,{...live,commercial:{...live.commercial,fee:6200}});assert.deepEqual(conflict.conflicts,['commercial.fee']);assert.equal(conflict.draft.commercial.fee,6100);
});
test('worker reads and recorded operation replays follow retired IDs',async()=>{
 const {callRecord}=await import('../workers/records.mjs'),{sha256}=require('./lib');const data={ally:content.migrate(fixture())};
 const args={board:'deals',fields:{brand:'Go Move',sourceKey:'source:b'},requestId:'old-create'},actor={email:'owner@example.com'};
 const operations={[sha256(actor.email+':'+args.requestId)]:{inputHash:sha256(JSON.stringify(args)),board:'deals',recordId:'w8rqzIpfy2V-',created:true,duplicate:false}};
 const workspace={async read(){return {data};},async history(){return {operations};}};
 const read=await callRecord(workspace,'getCrmRecord',{board:'deals',id:'w8rqzIpfy2V-'},actor);assert.equal(read.record.id,'PApPycnVxBSk');
 const replay=await callRecord(workspace,'saveCrmRecord',args,actor);assert.equal(replay.record.id,read.record.id);assert.equal(replay.replayed,true);
});
