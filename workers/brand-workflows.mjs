import finance from '../functions/brand-finance.js';
import { Store, sha256, seal, unseal } from './store.mjs';
import { verifyIdentity, exchangeFirebase, Workspace, boundedJson } from './firebase.mjs';

export const OWNER = 'theallydamon@gmail.com';
export const SCOPES = ['openid','email','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/calendar.events'];
const CLIENT = '139362174943-bg2h6vu4tgt6is8tu0ca415nea741fn3.apps.googleusercontent.com';
const ORIGIN = 'https://www.theallydamon.com';
const APP_URL = ORIGIN + '/ALLY_CRM/index.html#brand-deals';
const FOREVER = 8640000000000000;
const KEY = 'brand-workflows:owner';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const DEFAULTS = { scan:false, reminders:false, calendar:false };
const dayInSA = now => new Date(now).toLocaleDateString('en-CA',{timeZone:'Africa/Johannesburg'});
const json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':ORIGIN,'vary':'Origin'}});
const safeError = 'Brand workflow failed. Check Google access and retry. No success is confirmed.';

async function token(env, fields, fetcher) {
  const r = await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:CLIENT,client_secret:env.DRIVE_CLIENT_SECRET,...fields}).toString(),signal:AbortSignal.timeout(15000)});
  const value = await boundedJson(r,65536);
  if (!r.ok || !value.access_token) throw Error('Google access expired. Reconnect brand workflows.');
  return value;
}
export async function api(fetcher, accessToken, url, method='GET', body, extra={}) {
  const r = await fetcher(url,{method,headers:{authorization:'Bearer '+accessToken,...(body?{'content-type':'application/json'}:{}),...extra},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  if (r.status===204) return {};
  const data = await boundedJson(r,2*1024*1024);
  if (!r.ok) { const error=Error('Google operation failed.'); error.status=r.status; throw error; }
  return data;
}
async function credentials(env,store,fetcher) {
  const connection=await store.get(KEY);
  if (!connection) throw Error('Connect brand workflows first.');
  const secret=await unseal(env.CONNECTION_KEY,connection.credentials,KEY);
  const g=await token(env,{grant_type:'refresh_token',refresh_token:secret.googleRefresh},fetcher);
  const fb=await exchangeFirebase(env,secret.firebaseRefresh,fetcher);
  const identity=await verifyIdentity(env,fb.id_token,fetcher);
  if (identity.uid!==connection.uid || identity.email!==OWNER) throw Error('Reconnect the owner account.');
  const next={...connection,credentials:await seal(env.CONNECTION_KEY,{googleRefresh:g.refresh_token||secret.googleRefresh,firebaseRefresh:fb.refresh_token},KEY)};
  // A disconnect or newer consent must never be resurrected by a refresh in flight.
  const changed=await env.AUTH_DB.prepare('UPDATE auth_state SET payload=? WHERE key=? AND payload=? AND consumed=0').bind(JSON.stringify(next),KEY,JSON.stringify(connection)).run();
  if (changed.meta.changes!==1) throw Error('Connection changed. Try again.');
  return {connection:next,access:g.access_token,workspace:new Workspace(env,fb.id_token,fetcher,identity.uid)};
}
async function updateConnection(env, previous, patch) {
  const next={...previous,...patch};
  const result=await env.AUTH_DB.prepare('UPDATE auth_state SET payload=? WHERE key=? AND payload=? AND consumed=0').bind(JSON.stringify(next),KEY,JSON.stringify(previous)).run();
  if(result.meta.changes!==1) throw Error('Connection changed. Refresh and retry.');
  return next;
}
async function stillEnabled(store,flag) { const c=await store.get(KEY); if (!c?.settings?.[flag]) throw Error('Workflow is disabled.'); }

// Candidate evidence is never interpreted as commands, agreed terms, due dates, or settlement.
function bodyText(part) {
  let text='';
  if(part?.mimeType==='text/plain' && part.body?.data) text=Buffer.from(part.body.data,'base64url').toString('utf8');
  for(const child of part?.parts||[]) text+='\n'+bodyText(child);
  return text;
}
export function candidate(thread) {
  const messages=thread.messages||[];
  const latest=messages.at(-1); if(!latest) return null;
  const headers=Object.fromEntries((latest.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));
  const evidence=messages.map(m=> {
    const h=Object.fromEntries((m.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));
    return [h.date,h.from,h.subject,bodyText(m.payload)||m.snippet||'No readable text. Open Gmail to review attachments.'].join('\n');
  }).join('\n\n--- MESSAGE ---\n\n');
  const suggestions=[...new Set(evidence.match(/(?:ZAR|R|USD|GBP|EUR|\$|£|€)\s?\d[\d ,]*(?:\.\d{1,2})?/g)||[])].slice(0,12);
  return {threadId:thread.id,messageId:latest.id,subject:headers.subject||'Brand correspondence',from:headers.from||'',sourceUrl:'https://mail.google.com/mail/u/?authuser='+encodeURIComponent(OWNER)+'#all/'+thread.id,evidence:evidence.slice(-40000),truncated:evidence.length>40000,amountMentions:suggestions,attachmentReviewRequired:messages.some(m=>JSON.stringify(m.payload).includes('attachmentId')),reviewed:false};
}
// Match immutable source threads, including archived/closed campaigns. A brand name
// alone is not a duplicate: the same brand can commission a different campaign.
export function recordedCampaign(value,deals) {
  if(!/^[a-f0-9]+$/i.test(value.threadId)) return null;
  return deals.find(d=>[d.sourceKey,d.sourceUrl,d.notes,d.commercial?.evidence].some(text=>typeof text==='string' && (text.includes('gmail:'+value.threadId+':') || new RegExp('#(?:all|inbox|sent)/'+value.threadId+'(?:[^a-f0-9]|$)','i').test(text)))) || null;
}
export function opportunitySignal(value) {
  const subject=value.subject.replace(/^(?:(?:re|fw|fwd):\s*)+/ig,'').trim();
  // A creator job title in a signature is not an offer. Screen the actual
  // subject and substantive message text, before signatures and quoted replies.
  if(/(?:property24|myproperty|viewing confirmation|rental agreement|lease agreement|tax filing|expense breakdown|license renewal|licence renewal|clutch warning|discovery refund|delivery status notification|phone call (?:to|from)|item missing|shipment|account.*hibernation|password reset|focus groups|self.tape|movies for|webfluential feedback)/i.test(subject)) return false;
  if(/(?:social media collaboration|paid collab(?:oration)?|brand (?:campaign|partnership)|influencer (?:campaign|collab)|creator (?:campaign|brief)|sponsor(?:ship|ed)|ugc (?:campaign|collab)|collaboration\s*[|:])/i.test(subject)) return true;
  const substantive=value.evidence.split(/--- MESSAGE ---/).map(message=>message.split(/\n\s*(?:warm regards|kind regards|best regards|content creator\s*&\s*social media consultant|on .{0,160}wrote:|>{1,})/i)[0]).join('\n');
  const offer=/(?:we(?:'d| would) love to work with you|we(?:'re| are) (?:reaching out|looking for|casting)|upcoming campaign|paid collaboration|paid partnership|sponsored (?:post|video)|send (?:us |your )?(?:your )?rates|campaign brief|creator brief)/i.test(substantive);
  const scope=/(?:instagram|tiktok|ugc|reel|skit|deliverables|usage rights|content (?:piece|video)|influencer|creator)/i.test(substantive);
  return offer&&scope;
}
export async function reconcileCandidates(env,deals) {
  const pending=await env.AUTH_DB.prepare("SELECT id,payload FROM brand_candidates WHERE state='review' ORDER BY created LIMIT 50").all();
  for(const row of pending.results||[]) {
    const value=JSON.parse(row.payload);
    if(recordedCampaign(value,deals)) await env.AUTH_DB.prepare("UPDATE brand_candidates SET state='recorded' WHERE id=? AND payload=? AND state='review'").bind(row.id,row.payload).run();
  }
}
export async function scanInbox(env,store,ctx,fetcher) {
  await stillEnabled(store,'scan');
  // Bounded pages with a persisted continuation. A failed page never advances the cursor.
  const query='newer_than:90d -in:trash -in:spam -category:promotions -from:'+OWNER+' {"brand campaign" "paid collaboration" "paid collab" "paid partnership" "social media collaboration" "influencer campaign" "usage rights" "creator brief" "send your rates" "sponsored post"}';
  const state=await store.get('brand-scan-cursor');
  // Query changes invalidate Gmail page tokens, without losing dismissal history.
  const pageToken=state?.query===query?state.page:null;
  const live=await ctx.workspace.read(),deals=live.data.ally.deals?.deals||[];
  await reconcileCandidates(env,deals);
  const page=await api(fetcher,ctx.access,GMAIL+'/threads?maxResults=3&q='+encodeURIComponent(query)+(pageToken?'&pageToken='+encodeURIComponent(pageToken):''));
  for(const item of page.threads||[]) {
    const threadUrl=GMAIL+'/threads/'+encodeURIComponent(item.id);
    let thread, incomplete=false;
    try { thread=await api(fetcher,ctx.access,threadUrl+'?format=full'); }
    catch(e) {
      if(e.message!=='Backend response exceeds safe size limit.') throw e;
      // Keep large threads reviewable without repeatedly blocking this scan page.
      thread=await api(fetcher,ctx.access,threadUrl+'?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date');
      incomplete=true;
    }
    const value=candidate(thread);
    if(!value) continue;
    const existing=recordedCampaign(value,deals);
    if(existing || !opportunitySignal(value)) continue;
    if(incomplete) {
      value.truncated=true;
      value.attachmentReviewRequired=true;
      value.evidence='This thread exceeds the automatic reading limit. Open Gmail and review the full conversation and attachments before recording any terms.\n\n'+value.evidence;
      value.amountMentions=[];
    }
    await stillEnabled(store,'scan');
    const old=await env.AUTH_DB.prepare('SELECT payload FROM brand_candidates WHERE id=?').bind(value.threadId).first();
    if(old && JSON.parse(old.payload).messageId===value.messageId) continue;
    await env.AUTH_DB.prepare("INSERT INTO brand_candidates(id,payload,state,created) VALUES(?,?,'review',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state='review',created=excluded.created").bind(value.threadId,JSON.stringify(value),Date.now()).run();
  }
  await store.put('brand-scan-cursor',{page:page.nextPageToken||null,query},FOREVER);
  return {complete:!page.nextPageToken};
}
export function eventPlan(deal,invoice) {
  const id='b'+sha256('ally-crm:'+deal.id+':'+invoice.id);
  return {id,summary:'Payment due · '+deal.brand+' · '+invoice.number,description:[finance.money(finance.balance(invoice),finance.terms(deal).currency)+' outstanding',finance.terms(deal).campaign,invoice.evidence,'ALLY CRM: '+APP_URL].join('\n'),start:{date:invoice.dueDate},end:{date:finance.nextDay(invoice.dueDate)},visibility:'private',transparency:'transparent',reminders:{useDefault:false,overrides:[{method:'popup',minutes:540}]},extendedProperties:{private:{allyCRM:id}},attendees:[]};
}
async function saveJob(db,id,kind,state,payload) {
  await db.prepare('INSERT INTO brand_jobs(id,kind,state,payload,updated) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload,updated=excluded.updated').bind(id,kind,state,JSON.stringify(payload),Date.now()).run();
}
export async function syncCalendar(env,store,ctx,deals,fetcher) {
  const desired=new Map();
  for(const d of deals) for(const i of finance.terms(d).invoices||[]) if(finance.payable(d,i)) { const event=eventPlan(d,i); desired.set(event.id,event); }
  const old=await env.AUTH_DB.prepare("SELECT id,payload FROM brand_jobs WHERE kind='calendar'").all();
  let actions=0;
  for(const [id,event] of desired) {
    const prior=(old.results||[]).find(x=>x.id===id);
    if(prior && JSON.parse(prior.payload).hash===sha256(JSON.stringify(event))) continue;
    if(actions>=3) break;
    actions++;
    await stillEnabled(store,'calendar');
    // Reserve ownership before insertion so a lost provider response remains reconcilable.
    await saveJob(env.AUTH_DB,id,'calendar','pending',{hash:null});
    let existing;
    try { existing=await api(fetcher,ctx.access,CALENDAR+'/'+id); } catch(e) { if(e.status!==404 && e.status!==410) throw e; }
    if(existing && existing.extendedProperties?.private?.allyCRM!==id) throw Error('Calendar event ownership mismatch.');
    if(existing?.status==='cancelled') throw Error('A managed event was deleted in Google Calendar. Review it before reconnecting.');
    if(existing) await api(fetcher,ctx.access,CALENDAR+'/'+id+'?sendUpdates=none','PATCH',event,existing.etag?{'If-Match':existing.etag}:{});
    else {
      try { await api(fetcher,ctx.access,CALENDAR+'?sendUpdates=none','POST',event); }
      catch(e) { if(e.status!==409) throw e; continue; } // next run reads and reconciles the stable ID
    }
    await saveJob(env.AUTH_DB,id,'calendar','synced',{hash:sha256(JSON.stringify(event)),dueDate:event.start.date});
  }
  for(const row of old.results||[]) if(!desired.has(row.id)) {
    if(actions>=3) break;
    actions++;
    await stillEnabled(store,'calendar');
    let existing;
    try { existing=await api(fetcher,ctx.access,CALENDAR+'/'+row.id); } catch(e) { if(e.status!==404 && e.status!==410) throw e; }
    if(existing && existing.status!=='cancelled') {
      if(existing.extendedProperties?.private?.allyCRM!==row.id) throw Error('Calendar event ownership mismatch.');
      await api(fetcher,ctx.access,CALENDAR+'/'+row.id+'?sendUpdates=none','DELETE',null,existing.etag?{'If-Match':existing.etag}:{});
    }
    await env.AUTH_DB.prepare('DELETE FROM brand_jobs WHERE id=?').bind(row.id).run();
  }
}
export function digest(deals,day) {
  const lines=[];
  for(const d of deals) for(const i of finance.terms(d).invoices||[]) {
    const state=finance.reminder(d,i,day);
    if(state) lines.push(`${state.toUpperCase()} · ${d.brand} · ${i.number} · ${finance.money(finance.balance(i),finance.terms(d).currency)} · due ${i.dueDate}`);
  }
  return lines;
}
export function ownEmail(lines,day,id) {
  // No recipient, subject, MIME, or header is derived from an email, invoice, or request.
  const text='Your brand payments for '+day+'\n\n'+lines.join('\n')+'\n\nReview records and bank settlement in ALLY CRM: '+APP_URL+'\nNo client has been emailed.';
  return Buffer.from(['From: '+OWNER,'To: '+OWNER,'Subject: ALLY CRM payment reminders - '+day,'Message-ID: <'+id+'@theallydamon.com>','MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',Buffer.from(text).toString('base64')].join('\r\n')).toString('base64url');
}
export async function sendReminders(env,store,ctx,deals,fetcher,now=Date.now()) {
  const day=dayInSA(now), hour=Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:'Africa/Johannesburg'}).format(now));
  if(hour<7) return;
  const lines=digest(deals,day); if(!lines.length) return;
  const id='branddigest'+sha256(OWNER+day);
  const prior=await env.AUTH_DB.prepare('SELECT state,payload,updated FROM brand_jobs WHERE id=?').bind(id).first();
  if(prior?.state==='sent') return;
  if(prior?.state==='sending' || prior?.state==='uncertain') {
    // Gmail has no idempotency key. Search by our immutable Message-ID before resolving a lost response.
    if(prior.state==='sending' && Date.now()-prior.updated<120000) return;
    const found=await api(fetcher,ctx.access,GMAIL+'/messages?q='+encodeURIComponent('in:sent rfc822msgid:'+id+'@theallydamon.com'));
    await saveJob(env.AUTH_DB,id,'email',found.messages?.length?'sent':'uncertain',{day,messageId:id,needsReview:!found.messages?.length});
    return; // never blindly resend an ambiguous submission
  }
  await stillEnabled(store,'reminders');
  const claimed=await env.AUTH_DB.prepare("INSERT INTO brand_jobs(id,kind,state,payload,updated) VALUES(?,'email','sending',?,?) ON CONFLICT(id) DO UPDATE SET state='sending',updated=excluded.updated WHERE brand_jobs.state='retry' RETURNING id").bind(id,JSON.stringify({day,messageId:id}),Date.now()).first();
  if(!claimed) return;
  // Re-read live settlement/dates immediately before sending, then recheck the switch.
  try {
    const fresh=await ctx.workspace.read();
    const current=digest(fresh.data.ally.deals?.deals||[],day);
    if(!current.length) { await saveJob(env.AUTH_DB,id,'email','retry',{day,messageId:id}); return; }
    await stillEnabled(store,'reminders');
    const sent=await api(fetcher,ctx.access,GMAIL+'/messages/send','POST',{raw:ownEmail(current,day,id)});
    await saveJob(env.AUTH_DB,id,'email','sent',{day,messageId:id,gmailId:sent.id});
  } catch(e) {
    // A provider rejection is safe to retry; a timeout, 5xx or unknown result needs reconciliation.
    await saveJob(env.AUTH_DB,id,'email',e.status>=400 && e.status<500?'retry':'uncertain',{day,messageId:id,needsReview:!(e.status>=400 && e.status<500)});
    throw e;
  }
}
export async function runWorkflows(env,fetcher=(...args)=>fetch(...args),now=Date.now(),trigger='manual') {
  const store=new Store(env.AUTH_DB), original=await store.get(KEY);
  if(!original || !Object.values(original.settings||{}).some(Boolean)) return;
  // Cross-cron and manual-run lease. No concurrent scans, refresh rotation, or digests.
  const lease=await env.AUTH_DB.prepare("INSERT INTO brand_jobs(id,kind,state,payload,updated) VALUES('workflow-lock','lock','running','{}',?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated WHERE brand_jobs.updated < ? RETURNING id").bind(now,now-20*60000).first();
  if(!lease) return {busy:true};
  let ctx;
  try {
    ctx=await credentials(env,store,fetcher);
    const failures=[];
    if(ctx.connection.settings.scan) try { await scanInbox(env,store,ctx,fetcher); } catch { failures.push('Inbox scan'); }
    const live=await ctx.workspace.read(), deals=live.data.ally.deals?.deals||[];
    if(ctx.connection.settings.calendar) try { const current=await ctx.workspace.read(); await syncCalendar(env,store,ctx,current.data.ally.deals?.deals||[],fetcher); } catch { failures.push('Calendar sync'); }
    if(ctx.connection.settings.reminders) try { await sendReminders(env,store,ctx,deals,fetcher,now); } catch { failures.push('Payment email'); }
    await updateConnection(env,ctx.connection,{lastRun:now,...(trigger==='scheduled'?{lastScheduledRun:now}:{}),lastError:failures.length?failures.join(', ')+' failed. Check access and retry.':null});
    return {ok:!failures.length};
  } catch {
    const current=await store.get(KEY);
    if(current) await updateConnection(env,current,{lastRun:now,...(trigger==='scheduled'?{lastScheduledRun:now}:{}),lastError:safeError});
    throw Error(safeError);
  } finally {
    await env.AUTH_DB.prepare("DELETE FROM brand_jobs WHERE id='workflow-lock' AND updated=?").bind(now).run();
  }
}
export async function handleBrand(request,env,fetcher) {
  if(request.headers.get('origin')!==ORIGIN) return new Response(null,{status:403});
  if(request.method==='OPTIONS') return new Response(null,{status:204,headers:{'access-control-allow-origin':ORIGIN,'access-control-allow-methods':'POST','access-control-allow-headers':'Authorization, Content-Type, X-Requested-With','vary':'Origin'}});
  if(request.method!=='POST') return json({error:'Use POST.'},405);
  if(!env.AUTH_DB || !env.CONNECTION_KEY || !env.DRIVE_CLIENT_SECRET) return json({error:'Brand workflows need backend setup.'},503);
  if(request.headers.get('x-requested-with')!=='AllyCRM' || !(request.headers.get('content-type')||'').startsWith('application/json')) return json({error:'Invalid request.'},400);
  let actor;
  try { const h=request.headers.get('authorization')||''; if(!h.startsWith('Bearer ')) throw Error(); actor=await verifyIdentity(env,h.slice(7),fetcher); if(actor.email!==OWNER) throw Error(); }
  catch { return json({error:'Sign in with '+OWNER+' to manage brand workflows.'},401); }
  const store=new Store(env.AUTH_DB);
  if(!await store.limit('brand:'+sha256(actor.uid),120)) return json({error:'Try again later.'},429);
  const path=new URL(request.url).pathname;
  try {
    const input=await boundedJson(request,16384), previous=await store.get(KEY);
    if(path==='/brand/status') {
      const jobs=await env.AUTH_DB.prepare("SELECT id,kind,state,payload,updated FROM brand_jobs WHERE kind!='lock' ORDER BY updated DESC LIMIT 30").all();
      const count=await env.AUTH_DB.prepare("SELECT COUNT(*) AS count FROM brand_candidates WHERE state='review'").first();
      return json({connected:!!previous,settings:previous?.settings||DEFAULTS,lastRun:previous?.lastRun||null,lastScheduledRun:previous?.lastScheduledRun||null,lastError:previous?.lastError||null,reviewCount:count.count,jobs:jobs.results||[],recipient:OWNER});
    }
    if(path==='/brand/connect') {
      if(typeof input.code!=='string' || !input.code || input.code.length>4096) return json({error:'Invalid authorization code.'},400);
      const g=await token(env,{grant_type:'authorization_code',code:input.code,redirect_uri:ORIGIN},fetcher);
      const granted=(g.scope||'').split(' ');
      if(!SCOPES.filter(s=>s.startsWith('https:')).every(s=>granted.includes(s))) return json({error:'Approve Gmail read, self-reminder sending and Calendar events access.'},403);
      const profile=await api(fetcher,g.access_token,'https://www.googleapis.com/oauth2/v3/userinfo');
      if(!profile.email_verified || String(profile.email).toLowerCase()!==OWNER) return json({error:'Choose '+OWNER+'.'},403);
      const fb=await exchangeFirebase(env,String(input.refreshToken||''),fetcher), identity=await verifyIdentity(env,fb.id_token,fetcher);
      if(identity.uid!==actor.uid || identity.email!==OWNER) return json({error:'CRM identity mismatch.'},403);
      await new Workspace(env,fb.id_token,fetcher,actor.uid).read();
      const old=previous && await unseal(env.CONNECTION_KEY,previous.credentials,KEY);
      const googleRefresh=g.refresh_token||old?.googleRefresh;
      if(!googleRefresh) return json({error:'Google did not grant background access. Reconnect and approve access.'},409);
      // A separate encrypted grant leaves the Drive connection untouched. Switches start off.
      await store.put(KEY,{uid:actor.uid,email:OWNER,settings:previous?.settings||DEFAULTS,credentials:await seal(env.CONNECTION_KEY,{googleRefresh,firebaseRefresh:fb.refresh_token},KEY)},FOREVER);
      return json({connected:true});
    }
    if(path==='/brand/disconnect') {
      await env.AUTH_DB.prepare('DELETE FROM auth_state WHERE key=?').bind(KEY).run();
      return json({connected:false});
    }
    if(!previous) return json({error:'Connect brand workflows first.'},409);
    if(path==='/brand/settings') {
      const settings=input.settings;
      if(!settings || Object.keys(settings).some(k=>!Object.hasOwn(DEFAULTS,k)) || Object.values(settings).some(v=>typeof v!=='boolean')) return json({error:'Invalid settings.'},400);
      await updateConnection(env,previous,{settings:{...previous.settings,...settings}});
      return json({saved:true});
    }
    if(path==='/brand/candidates') {
      const page=await env.AUTH_DB.prepare("SELECT id,payload FROM brand_candidates WHERE state='review' ORDER BY created DESC LIMIT 50").all();
      return json({candidates:(page.results||[]).map(r=>({...JSON.parse(r.payload),id:r.id}))});
    }
    if(path==='/brand/dismiss') {
      if(!['dismissed','recorded'].includes(input.state) || typeof input.id!=='string' || typeof input.messageId!=='string') return json({error:'Invalid candidate.'},400);
      const changed=await env.AUTH_DB.prepare("UPDATE brand_candidates SET state=? WHERE id=? AND json_extract(payload,'$.messageId')=?").bind(input.state,input.id,input.messageId).run();
      return json({saved:changed.meta.changes===1});
    }
    if(path==='/brand/run') return json(await runWorkflows(env,fetcher));
    return json({error:'Not found.'},404);
  } catch { return json({error:safeError},502); }
}
