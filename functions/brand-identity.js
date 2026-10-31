/* Brand profiles have one identity. Names, old record IDs and source keys are aliases. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.BrandIdentity=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o||{},k);
  const unique=values=>[...new Set(values.filter(v=>v!==undefined&&v!==null&&v!==''))];
  function key(name){return String(name||'').normalize('NFKD').replace(/\([^)]*@[\w.]+[^)]*\)/g,'').replace(/@[\w.]+/g,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
  const names=d=>unique([d.brand,...(d.brandAliases||[])]);
  function find(deals,name,exceptId){const k=key(name);return k?deals.find(d=>d.id!==exceptId&&names(d).some(n=>key(n)===k)):undefined;}
  function resolve(aliases,id){const visited=new Set();while(own(aliases,id)){if(visited.has(id))throw Error('Brand alias cycle.');visited.add(id);id=aliases[id];}return id;}
  const sourceMatches=(record,source)=>[record.sourceKey,...(record.sourceKeys||[])].includes(source);
  const textJoin=(a,b)=>!b||a===b||String(a||'').includes(b)?a||'':!a?b:a+'\n\n'+b;
  function unionRecords(a=[],b=[]){return [...a,...b.filter(x=>!a.some(y=>y.id===x.id))];}
  function compatible(a,b){return ['stage','currency','fee','agencyFee','tax','reviewed','paymentStatus','billingStatus','invoices'].every(k=>JSON.stringify(a?.[k]??null)===JSON.stringify(b?.[k]??null));}
  function rebase(base,draft,live){
    const conflicts=[],equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b),object=x=>x&&typeof x==='object'&&!Array.isArray(x);
    function merge(b,l,r,path){
      if(equal(l,b))return r;
      if(equal(r,b)||equal(l,r))return l;
      if(object(l)&&object(r))return Object.fromEntries(unique([...Object.keys(b||{}),...Object.keys(l),...Object.keys(r)]).map(k=>[k,merge(b?.[k],l[k],r[k],path?path+'.'+k:k)]).filter(([,v])=>v!==undefined));
      conflicts.push(path);return l;
    }
    return {draft:merge(base,draft,live,''),conflicts};
  }
  function migrate(ally){
    if(!Array.isArray(ally?.deals?.deals))return ally;
    let deals=ally.deals.deals.map(d=>({...d})),items=(ally.brandContent?.items||[]).map(i=>({...i}));
    const aliases={...(ally.deals.aliases||{})},contentAliases={...(ally.brandContent?.aliases||{})},history=[...(ally.deals.mergeHistory||[])];
    // Owner-confirmed duplicate enquiry. Financial terms must still agree before first consolidation.
    const canonical=deals.find(d=>d.id==='PApPycnVxBSk'),duplicate=deals.find(d=>d.id==='w8rqzIpfy2V-');
    if(canonical&&duplicate&&(own(aliases,duplicate.id)||compatible(canonical.commercial,duplicate.commercial))){
      const historyId='gomove-single-profile-v1';
      let audit=history.find(h=>h.id===historyId);
      if(!audit){audit={id:historyId,canonicalId:canonical.id,before:{deals:[JSON.parse(JSON.stringify(canonical)),JSON.parse(JSON.stringify(duplicate))],content:items.filter(i=>[canonical.id,duplicate.id].includes(i.dealId)||['-y2Kb_0PEy3c','LxkJVwcLzLl9'].includes(i.id)).map(i=>JSON.parse(JSON.stringify(i)))}};history.push(audit);}
      aliases[duplicate.id]=canonical.id;
      const firstMerge=!(canonical.brandAliases||[]).includes(duplicate.brand);
      canonical.brandAliases=unique([...names(canonical),...names(duplicate)]);
      canonical.sourceKeys=unique([canonical.sourceKey,...(canonical.sourceKeys||[]),duplicate.sourceKey,...(duplicate.sourceKeys||[])]);
      canonical.sourceUrls=unique([canonical.sourceUrl,...(canonical.sourceUrls||[]),duplicate.sourceUrl,...(duplicate.sourceUrls||[])]);
      if(!canonical.sourceUrl&&duplicate.sourceUrl)canonical.sourceUrl=duplicate.sourceUrl;
      if(firstMerge){
        canonical.notes=textJoin(canonical.notes,duplicate.notes);
        canonical.tasks=unionRecords(canonical.tasks,duplicate.tasks);
        canonical.attachments=unionRecords(canonical.attachments,duplicate.attachments);
        canonical.links=unionRecords(canonical.links,duplicate.links);
        if(canonical.commercial&&duplicate.commercial){canonical.commercial={...canonical.commercial};for(const k of ['evidence','paymentEvidence','billingEvidence','contact','agency','paymentTerms','deliverables','rights'])canonical.commercial[k]=textJoin(canonical.commercial[k],duplicate.commercial[k]);}
      }
      // Retain any stale-client resurrection in the audit instead of restoring a second editable record.
      if(!firstMerge&&JSON.stringify(duplicate)!==JSON.stringify(audit.before.deals[1])){
        const recovered=audit.recoveredRecords||[];
        if(!recovered.some(r=>JSON.stringify(r)===JSON.stringify(duplicate))){audit={...audit,recoveredRecords:[...recovered,duplicate]};history[history.findIndex(h=>h.id===historyId)]=audit;}
      }
      deals=deals.filter(d=>d.id!==duplicate.id);
      items=items.map(i=>i.dealId===duplicate.id?{...i,dealId:canonical.id}:i);
    }
    if(canonical&&own(aliases,'w8rqzIpfy2V-')){
      const primary=items.find(i=>i.id==='-y2Kb_0PEy3c'),extra=items.find(i=>i.id==='LxkJVwcLzLl9');
      if(extra&&own(contentAliases,extra.id)){
        const index=history.findIndex(h=>h.canonicalId===canonical.id);
        if(index>=0){const audit=history[index],original=audit.before.content.find(i=>i.id===extra.id),recovered=audit.recoveredContent||[];
          if(JSON.stringify(extra)!==JSON.stringify(original)&&!recovered.some(i=>JSON.stringify(i)===JSON.stringify(extra)))history[index]={...audit,recoveredContent:[...recovered,extra]};}
      }
      if(primary&&extra&&['status','due','scheduledFor','paused'].every(k=>(primary[k]??null)===(extra[k]??null))&&(primary.desc===extra.desc||!primary.desc||primary.desc==='TBD'||!extra.desc||extra.desc==='TBD')&&(!primary.caption||!extra.caption||primary.caption===extra.caption)){
        if((!primary.desc||primary.desc==='TBD')&&extra.desc&&extra.desc!=='TBD'){primary.desc=extra.desc;primary.descHtml=!!extra.descHtml;}
        if(!primary.caption)primary.caption=extra.caption||'';
        primary.sourceKeys=unique([primary.sourceKey,...(primary.sourceKeys||[]),extra.sourceKey,...(extra.sourceKeys||[])]);
        primary.sourceUrls=unique([primary.sourceUrl,...(primary.sourceUrls||[]),extra.sourceUrl,...(extra.sourceUrls||[])]);
        primary.links=unionRecords(primary.links,extra.links);primary.attachments=unionRecords(primary.attachments,extra.attachments);
        contentAliases[extra.id]=primary.id;items=items.filter(i=>i.id!==extra.id);
      }
    }
    // Retired content IDs remain redirects even if an older tab writes the old array back.
    items=items.filter(item=>{
      const targetId=resolve(contentAliases,item.id);
      if(targetId===item.id||!items.some(other=>other.id===targetId))return true;
      const index=history.findIndex(h=>h.canonicalId===resolve(aliases,item.dealId));
      if(index>=0){const audit=history[index],original=audit.before.content.find(i=>i.id===item.id),recovered=audit.recoveredContent||[];
        if(JSON.stringify(item)!==JSON.stringify(original)&&!recovered.some(i=>JSON.stringify(i)===JSON.stringify(item)))history[index]={...audit,recoveredContent:[...recovered,item]};}
      return false;
    });
    deals=deals.map(d=>({...d,brandKey:key(d.brand),brandAliases:names(d),tasks:(d.tasks||[]).map(t=>t.contentId?{...t,contentId:resolve(contentAliases,t.contentId)}:t),...(d.primaryContentId?{primaryContentId:resolve(contentAliases,d.primaryContentId)}:{})}));
    items=items.map(i=>i.dealId?{...i,dealId:resolve(aliases,i.dealId)}:i);
    const next={...ally,deals:{...ally.deals,deals,aliases,mergeHistory:history},brandContent:{...ally.brandContent,items,aliases:contentAliases}};
    return JSON.stringify(next)===JSON.stringify(ally)?ally:next;
  }
  return {key,names,find,resolve,sourceMatches,rebase,migrate};
});
