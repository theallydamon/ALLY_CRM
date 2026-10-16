import auth from '../functions/crm-auth.js';
import { Store, ALLOWED_EMAILS, sha256, randomToken, secretEqual, seal } from './store.mjs';
import { verifyIdentity, exchangeFirebase, sessionToken, Workspace, boundedJson } from './firebase.mjs';
import { TOOL_DEFINITIONS, callRecord } from './records.mjs';
const { requestedScopes, hasScope, redirectUriAllowed } = auth;
const SCOPES = ['crm.records.read', 'crm.records.write', 'offline_access'];
const CODE_TTL = 300000, SESSION_TTL = 90 * 86400000;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers } });
const failure = (error, status = 400) => json({ error }, status);
function origin(env) {
  const url = new URL(env.PUBLIC_ORIGIN);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Invalid connector origin.');
  return url.origin;
}
async function body(request) {
  if (Number(request.headers.get('content-length')) > 65536) throw new Error('Request too large.');
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) return boundedJson(request, 65536);
  if (type.includes('application/x-www-form-urlencoded')) {
    const reader = request.body?.getReader(); let bytes = 0; const chunks = [];
    if (!reader) return {};
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 65536) { await reader.cancel(); throw new Error('Request too large.'); } chunks.push(part.value); }
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
  }
  throw new Error('Use JSON or form encoding.');
}
async function issue(store, actor) {
  const access = randomToken(36), refresh = randomToken(48);
  await store.putTokens(access, refresh, actor, actor.expiresAt);
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: actor.scope };
}
function loginHtml(base, pendingId, scope, env, nonce) {
  const config = JSON.stringify({ apiKey: env.FIREBASE_API_KEY, authDomain: 'ally-crm-cbdd1.firebaseapp.com', projectId: env.FIREBASE_PROJECT, appId: '1:139362174943:web:ea4df75838f6dfcf80a66a' }).replaceAll('<', '\\u003c');
  const permissions = [hasScope({scope},'crm.records.read') && 'read CRM records',hasScope({scope},'crm.records.write') && 'create and update CRM records'].filter(Boolean).join('; ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect ALLY CRM</title><style nonce="${nonce}">body{font:16px system-ui;max-width:520px;margin:12vh auto;padding:24px}button{padding:14px;border:0;border-radius:12px;background:#202124;color:white}#error{color:#b42318}</style></head><body><h1>Connect ALLY CRM</h1><p>Your assistant may ${permissions || 'connect to the CRM'}. No deletion is available.</p><p>This stores an encrypted Firebase sign-in credential in your Cloudflare account to access your CRM using your existing account permissions. This connection expires after 90 days. You can revoke it using the disconnect instructions.</p><button id="connect">Connect with Google</button><p id="error"></p><script src="https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js"></script><script src="https://www.gstatic.com/firebasejs/12.15.0/firebase-auth-compat.js"></script><script nonce="${nonce}">firebase.initializeApp(${config});document.getElementById('connect').onclick=async()=>{const el=document.getElementById('error');el.textContent='';try{await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.NONE);const result=await firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider());const response=await fetch(${JSON.stringify(base+'/oauth/approve')},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pendingId:${JSON.stringify(pendingId)},idToken:await result.user.getIdToken(),refreshToken:result.user.refreshToken})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Connection failed');location.href=data.redirect;}catch(e){el.textContent=e.message||'Connection failed';}};</script></body></html>`;
}
export function createHandler(fetcher = (input, init) => fetch(input, init)) {
  return async function handle(request, env) {
    let path;
    try {
      const url = new URL(request.url); path = url.pathname.replace(/\/$/, '') || '/';
      const base = origin(env), resource = base + '/mcp', method = request.method;
      if (method === 'GET' && path === '/health') return json({ ok: true, service: 'ALLY CRM Workers connector', version: '3.0.0', configured: Boolean(env.AUTH_DB && env.CONNECTION_KEY && env.FIREBASE_SERVER_API_KEY), serverAuthConfigured: Boolean(env.FIREBASE_SERVER_API_KEY), crmVerified: false });
      if (method === 'GET' && ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'].includes(path)) return json({ resource, authorization_servers: [base], scopes_supported: SCOPES });
      if (method === 'GET' && ['/.well-known/oauth-authorization-server','/.well-known/openid-configuration'].includes(path)) return json({ issuer: base, authorization_response_iss_parameter_supported: true, authorization_endpoint: base + '/oauth/authorize', token_endpoint: base + '/oauth/token', registration_endpoint: base + '/oauth/register', revocation_endpoint: base + '/oauth/revoke', revocation_endpoint_auth_methods_supported: ['client_secret_post'], response_types_supported: ['code'], grant_types_supported: ['authorization_code','refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'], scopes_supported: SCOPES });
      if (path === '/mcp' && method === 'GET') return new Response(null,{status:405,headers:{allow:'POST'}});
      if (!env.AUTH_DB || !env.CONNECTION_KEY) return failure('Connector setup is incomplete.', 503);
      if (method !== 'GET' && method !== 'POST') return failure('method_not_allowed', 405);
      const requestOrigin = request.headers.get('origin');
      if (requestOrigin && requestOrigin !== base && requestOrigin !== 'https://chatgpt.com' && requestOrigin !== 'https://claude.ai') return failure('Origin is not allowed.', 403);
      const store = new Store(env.AUTH_DB);
      if (path.startsWith('/oauth/')) {
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        if (!await store.limit(sha256(ip) + ':' + path, path === '/oauth/token' ? 120 : 60)) return failure('rate_limit_exceeded', 429);
      }
      if (method === 'POST' && path === '/oauth/register') {
        const input = await body(request), redirects = input.redirect_uris;
        if (!Array.isArray(redirects) || !redirects.length || redirects.length > 5 || redirects.some(uri => !redirectUriAllowed(uri,env.CHATGPT_REDIRECT_URIS || ''))) return failure('invalid_redirect_uri');
        const clientId = randomToken(24), clientSecret = randomToken(36);
        await store.put('client:' + clientId, { secretHash: sha256(clientSecret), redirectUris: redirects }, Date.now() + SESSION_TTL);
        return json({ client_id: clientId, client_secret: clientSecret, client_secret_expires_at: Math.floor((Date.now()+SESSION_TTL)/1000), redirect_uris: redirects, grant_types: ['authorization_code','refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post' }, 201);
      }
      if (method === 'GET' && path === '/oauth/authorize') {
        const q = Object.fromEntries(url.searchParams), client = await store.get('client:' + q.client_id);
        if (!client || !client.redirectUris.includes(q.redirect_uri) || !redirectUriAllowed(q.redirect_uri,env.CHATGPT_REDIRECT_URIS || '')) return failure('Unknown OAuth client or redirect URI.');
        const redirectError = error => { const callback = new URL(q.redirect_uri); callback.searchParams.set('error',error); callback.searchParams.set('iss',base); if(q.state) callback.searchParams.set('state',q.state); return new Response(null,{status:302,headers:{location:callback.toString(),'cache-control':'no-store'}}); };
        if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge || '') || (q.state || '').length > 2048) return redirectError('invalid_request');
        if (q.resource && q.resource !== resource) return redirectError('invalid_target');
        let scope; try { scope = requestedScopes(q.scope || SCOPES.join(' '),q.redirect_uri); if (scope.split(' ').some(s=>!SCOPES.includes(s))) throw new Error('Unsupported scope'); } catch { return redirectError('invalid_scope'); }
        // This new connection exposes record tools. Existing task-only Firebase/Claude setup remains separate.
        if (!scope.split(' ').some(s=>s==='crm.records.read'||s==='crm.records.write')) return redirectError('invalid_scope');
        const pendingId = randomToken(24), nonce = randomToken(16);
        await store.put('pending:'+pendingId,{clientId:q.client_id,redirectUri:q.redirect_uri,state:q.state||'',challenge:q.code_challenge,scope,resource},Date.now()+CODE_TTL);
        return new Response(loginHtml(base,pendingId,scope,env,nonce),{headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}' https://www.gstatic.com https://apis.google.com; style-src 'nonce-${nonce}'; frame-src https://ally-crm-cbdd1.firebaseapp.com https://accounts.google.com; connect-src 'self' https://*.googleapis.com https://ally-crm-cbdd1.firebaseapp.com; img-src 'self' https://*.googleusercontent.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`}});
      }
      if (method === 'POST' && path === '/oauth/approve') {
        const input = await body(request), key = 'pending:'+String(input.pendingId || ''), pending = await store.get(key);
        if (!pending) return failure('This connection request expired.');
        const identity = await verifyIdentity(env,String(input.idToken || ''),fetcher);
        const refreshed = await exchangeFirebase(env,String(input.refreshToken || ''),fetcher);
        const refreshIdentity = await verifyIdentity(env,refreshed.id_token,fetcher);
        if (identity.uid !== refreshIdentity.uid || identity.email !== refreshIdentity.email) return failure('Sign-in credentials do not match.',403);
        // A harmless real workspace read validates access before granting the connection.
        await new Workspace(env,refreshed.id_token,fetcher,identity.uid).read();
        if (!await store.claim(key)) return failure('Connection request was already used.');
        const sessionId = randomToken(24), code = randomToken(32), expiresAt = Date.now()+SESSION_TTL;
        await store.put('session:'+sessionId,{...identity,expiresAt,credentials:await seal(env.CONNECTION_KEY,{refreshToken:refreshed.refresh_token},sessionId)},expiresAt);
        await store.put('code:'+sha256(code),{...pending,...identity,sessionId,expiresAt},Date.now()+CODE_TTL);
        const callback = new URL(pending.redirectUri); callback.searchParams.set('iss',base); callback.searchParams.set('code',code); if(pending.state) callback.searchParams.set('state',pending.state);
        return json({redirect:callback.toString()});
      }
      if (method === 'POST' && path === '/oauth/token') {
        const input = await body(request), client = await store.get('client:'+input.client_id);
        if (!client || !secretEqual(sha256(String(input.client_secret || '')),client.secretHash)) return failure('invalid_client',401);
        let key, grant;
        if (input.grant_type === 'authorization_code') {
          key='code:'+sha256(String(input.code || '')); grant=await store.get(key);
          const verifier=String(input.code_verifier||'');
          if (!grant || grant.clientId !== input.client_id || grant.redirectUri !== input.redirect_uri || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !secretEqual(Buffer.from(sha256(verifier),'hex').toString('base64url'),grant.challenge)) return failure('invalid_grant');
        } else if (input.grant_type === 'refresh_token') {
          key='token:'+sha256(String(input.refresh_token || '')); grant=await store.get(key);
          if (!grant || grant.kind !== 'refresh' || grant.clientId !== input.client_id || !ALLOWED_EMAILS.has(grant.email)) return failure('invalid_grant');
        } else return failure('unsupported_grant_type');
        if (input.resource && input.resource !== grant.resource) return failure('invalid_target');
        if (input.scope && input.scope !== grant.scope) return failure('invalid_scope');
        if (!await store.get('session:'+grant.sessionId) || !await store.claim(key)) return failure('invalid_grant');
        return json(await issue(store,{email:grant.email,uid:grant.uid,clientId:grant.clientId,sessionId:grant.sessionId,scope:grant.scope,resource:grant.resource,expiresAt:grant.expiresAt}));
      }
      if (method === 'POST' && path === '/oauth/revoke') {
        const input=await body(request),client=await store.get('client:'+input.client_id);
        if(!client || !secretEqual(sha256(String(input.client_secret||'')),client.secretHash)) return failure('invalid_client',401);
        const token=await store.get('token:'+sha256(String(input.token||'')));
        if(token && token.clientId===input.client_id) await store.claim('session:'+token.sessionId);
        return json({});
      }
      if (path === '/mcp') {
        const header=request.headers.get('authorization')||'';
        const actor=header.startsWith('Bearer ') ? await store.get('token:'+sha256(header.slice(7))) : null;
        if (!actor || actor.kind !== 'access' || actor.resource !== resource || !ALLOWED_EMAILS.has(actor.email) || !await store.get('session:'+actor.sessionId)) return json({error:'unauthorized'},401,{'www-authenticate':`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`});
        const input=await body(request);
        if (!input || input.jsonrpc !== '2.0' || typeof input.method !== 'string' || Array.isArray(input)) return failure('Invalid JSON-RPC request.');
        if (input.method==='notifications/initialized') return new Response(null,{status:202});
        const envelope={jsonrpc:'2.0',id:input.id ?? null};
        if(input.method==='initialize') return json({...envelope,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'ALLY CRM',version:'3.0.0'}}});
        if(input.method==='ping') return json({...envelope,result:{}});
        if(input.method==='tools/list') return json({...envelope,result:{tools:TOOL_DEFINITIONS.filter(tool=>hasScope(actor,tool.name==='saveCrmRecord'?'crm.records.write':'crm.records.read')).map(tool=>({...tool,securitySchemes:[{type:'oauth2',scopes:[tool.name==='saveCrmRecord'?'crm.records.write':'crm.records.read']}]}))}});
        if(input.method==='tools/call' && TOOL_DEFINITIONS.some(tool=>tool.name===input.params?.name)) {
          const name=input.params.name,needed=name==='saveCrmRecord'?'crm.records.write':'crm.records.read';
          const toolError=message=>json({...envelope,result:{isError:true,content:[{type:'text',text:message}]}});
          if(!hasScope(actor,needed)) return toolError('Missing '+needed+' permission. Reconnect with approval.');
          try {
            const token=await sessionToken(env,store,actor,fetcher);
            const result=await callRecord(new Workspace(env,token,fetcher,actor.uid),name,input.params.arguments||{},actor);
            return json({...envelope,result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result}});
          } catch(error) { return toolError(error.message || 'CRM operation failed.'); }
        }
        return json({...envelope,error:{code:-32601,message:'Method not found'}});
      }
      return failure('not_found',404);
    } catch(error) {
      // Never log request bodies, headers, tokens, or CRM content.
      console.error(JSON.stringify({event:'connector_request_failed',path:path||'unknown'}));
      return failure('Request failed. Check connector setup or reconnect.',400);
    }
  };
}
export default {
  fetch: createHandler(),
  async scheduled(_event,env) {
    await env.AUTH_DB.batch([
      env.AUTH_DB.prepare('DELETE FROM auth_state WHERE key IN (SELECT key FROM auth_state WHERE expires <= ? LIMIT 1000)').bind(Date.now()),
      env.AUTH_DB.prepare('DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires <= ? LIMIT 1000)').bind(Date.now())
    ]);
  }
};
