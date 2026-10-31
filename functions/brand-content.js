/* Shared brand content migration. Only exact identities link records; titles never merge campaigns. */
(function(root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./brand-identity') : root.BrandIdentity);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrandContent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(identity) {
  'use strict';
  // Fingerprints of the three reviewed enquiry-note descriptions, never their private text.
  const adminDescriptions = {
  "-y2Kb_0PEy3c": "158:2687194962",
  "-fw2WLxLPwkz": "348:2398050921",
  "LxkJVwcLzLl9": "361:3869217153"
};
  function fingerprint(value) { let h=2166136261; for(let n=0;n<value.length;n++)h=Math.imul(h^value.charCodeAt(n),16777619);return value.length+':'+(h>>>0); }
  const prefix = key => String(key || '').replace(/:content(?::[^:]*)?$/, '').replace(/:deal$/, '');
  const hasText = value => typeof value === 'string' && !!value.trim();
  const plain = value => String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  function migrate(ally) {
    if (!ally?.deals?.deals) return ally;
    ally=identity.migrate(ally);
    let items = (ally.brandContent?.items || []).map(i => ({...i}));
    const deals = ally.deals.deals.map(original => {
      const d = {...original, tasks: (original.tasks || []).map(t => ({...t}))};
      const matched = items.filter(i => i.dealId === d.id || (!i.dealId && (
        d.sourceKey && i.sourceKey && [d.sourceKey,...(d.sourceKeys||[])].some(source=>prefix(source) === prefix(i.sourceKey)) ||
        d.hubspotDealId && i.hubspotDealId === d.hubspotDealId && ally.deals.deals.filter(other=>other.hubspotDealId===d.hubspotDealId).length===1
      )));
      for (const i of matched) {
        i.dealId = d.id;
        if (!i.contentSchemaVersion && hasText(i.desc) && adminDescriptions[i.id] === fingerprint(i.desc)) {
          // These three reviewed records contained enquiry notes, not scripts. Retain them on the deal.
          const note = 'Previous content notes (' + i.id + ')\n' + i.desc;
          d.notes = [d.notes || '', note].filter(Boolean).join('\n\n');
          i.desc = 'TBD'; i.descHtml = false;
        }
      }
      const create = (id, title, desc, caption='') => {
        const existing = items.find(i => i.id === id);
        if (existing) { if (existing.dealId !== d.id) throw Error('Content identity conflict.'); return existing; }
        const i = {id,dealId:d.id,title,desc:desc || 'TBD',caption:caption || '',status:d.stage==='done'?'Posted':'Ideas',created:d.created || '',due:null,scheduledFor:null,descHtml:false,sourceKey:'deal:'+d.id+':content:'+id};
        items.push(i); matched.push(i); return i;
      };
      for (const t of d.tasks) {
        if (t.contentId) continue;
        const exact = matched.filter(i => hasText(t.description) && plain(i.desc) === plain(t.description));
        // Explicit content metadata, an exact script match, or the reviewed Market Liquors script.
        const isContent = t.kind === 'content' || t.title === 'Story' && matched.length > 0 || t.id === '7d3zn3y' || exact.length === 1;
        if (!isContent) continue;
        let i = exact.length === 1 ? exact[0] : matched.length === 1 && matched[0].desc === 'TBD' ? matched[0] : null;
        if (!i) i = create('deal-'+d.id+'-task-'+t.id, t.title || d.brand+' '+(d.piece||'Reel'), t.description, t.caption);
        else if (i.desc === 'TBD' && hasText(t.description)) { i.desc=t.description; i.descHtml=false; i.title=t.title || i.title; }
        if (hasText(t.caption) && i.caption && i.caption !== t.caption) create('deal-'+d.id+'-task-'+t.id+'-caption',t.title || 'Caption','TBD',t.caption);
        else if (hasText(t.caption)) i.caption=t.caption;
        t.contentId=i.id;
        delete t.description; delete t.caption;
      }
      if (!d.contentSchemaVersion && (hasText(d.script) || hasText(d.caption))) {
        let i = matched.length === 1 ? matched[0] : null;
        if (!i) i=create('deal-'+d.id+'-primary', d.brand+' '+(d.piece||'Reel'), d.script, d.caption);
        else {
          if (hasText(d.script) && plain(i.desc) !== plain(d.script)) {
            if (!hasText(i.desc) || i.desc==='TBD') {i.desc=d.script;i.descHtml=false;}
            else i=create('deal-'+d.id+'-legacy-script',d.brand+' '+(d.piece||'Reel'),d.script,d.caption);
          }
          if (hasText(d.caption) && i.caption && i.caption!==d.caption) i=create('deal-'+d.id+'-legacy-caption',d.brand+' '+(d.piece||'Reel')+' caption', 'TBD',d.caption);
          else if (hasText(d.caption)) i.caption=d.caption;
        }
        d.primaryContentId=i.id;
        // Remove the old editable copies only after preserving both values in canonical content.
        d.script=''; d.caption='';
      }
      for (const i of matched) {
        if (!hasText(i.desc)) i.desc='TBD';
        if (i.caption == null) i.caption='';
        i.contentSchemaVersion=1;
      }
      d.contentSchemaVersion=1;
      return d;
    });
    items=items.map(i=>({...i,desc:hasText(i.desc)?i.desc:'TBD',caption:i.caption || ''}));
    const next=identity.migrate({...ally,brandContent:{...ally.brandContent,items},deals:{...ally.deals,deals}});
    return JSON.stringify(next)===JSON.stringify(ally)?ally:next;
  }
  function update(ally, id, patch) {
    id=identity.resolve(ally.brandContent?.aliases,id);
    if (!(ally.brandContent?.items || []).some(i=>i.id===id)) throw Error('Content no longer exists. Reopen the deal.');
    return {...ally,brandContent:{...ally.brandContent,items:ally.brandContent.items.map(i=>i.id===id?{...i,...patch}:i)}};
  }
  function groups(ally,query='') {
    const groups=new Map(),q=query.toLowerCase();
    for(const item of ally.brandContent?.items||[]){
      const dealId=identity.resolve(ally.deals?.aliases,item.dealId),deal=ally.deals?.deals?.find(d=>d.id===dealId);
      const brand=deal?.brand||'Unassigned content';
      if(q&&![brand,item.title,item.desc].join(' ').toLowerCase().includes(q))continue;
      const key=deal?.id||'unassigned';
      if(!groups.has(key))groups.set(key,{dealId:deal?.id||'',brand,items:[]});
      groups.get(key).items.push(item);
    }
    return [...groups.values()];
  }
  return {migrate,update,groups};
});
