import { Store, seal, unseal, sha256 } from './store.mjs';
import { verifyIdentity, boundedJson } from './firebase.mjs';

const CLIENT_ID = '139362174943-bg2h6vu4tgt6is8tu0ca415nea741fn3.apps.googleusercontent.com';
const CRM_ORIGIN = 'https://www.theallydamon.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
// No application-imposed expiry: Google's revocation and account policies still apply.
const STORED_UNTIL = 8640000000000000;
const reply = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
    'access-control-allow-origin': CRM_ORIGIN, 'vary': 'Origin', 'referrer-policy': 'no-referrer' }
});

async function googleToken(env, fields, fetcher) {
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: env.DRIVE_CLIENT_SECRET, ...fields }).toString(),
    signal: AbortSignal.timeout(15000)
  });
  const result = await boundedJson(response, 65536);
  if (!response.ok) {
    const error = new Error(result.error === 'invalid_grant' ? 'Reconnect Drive.' : 'Drive connection could not be renewed. Try again.');
    error.revoked = result.error === 'invalid_grant';
    throw error;
  }
  if (!result.access_token || !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0) throw new Error('Drive did not return a valid connection.');
  return result;
}

export async function handleDrive(request, env, fetcher) {
  const origin = request.headers.get('origin');
  if (origin !== CRM_ORIGIN) return new Response(null, { status: 403 });
  const path = new URL(request.url).pathname;
  if (!['/drive/connect', '/drive/token', '/drive/disconnect'].includes(path)) return reply({ error: 'Not found.' }, 404);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'access-control-allow-origin': CRM_ORIGIN, 'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'Authorization, Content-Type, X-Requested-With', 'vary': 'Origin'
  } });
  if (request.method !== 'POST') return reply({ error: 'Use POST.' }, 405);
  if (!env.AUTH_DB || !env.CONNECTION_KEY || !env.DRIVE_CLIENT_SECRET) return reply({ error: 'Persistent Drive connection is not configured yet.' }, 503);
  if (request.headers.get('x-requested-with') !== 'AllyCRM' || !(request.headers.get('content-type') || '').startsWith('application/json')) return reply({ error: 'Invalid request.' }, 400);
  let actor;
  try {
    const bearer = request.headers.get('authorization') || '';
    if (!bearer.startsWith('Bearer ')) throw new Error();
    actor = await verifyIdentity(env, bearer.slice(7), fetcher);
  } catch { return reply({ error: 'Sign in to the CRM again.' }, 401); }
  const store = new Store(env.AUTH_DB), key = 'drive:' + sha256(actor.uid);
  if (!await store.limit(key, 120)) return reply({ error: 'Too many requests. Try again later.' }, 429);
  try {
    const input = await boundedJson(request, 16384);
    if (path === '/drive/disconnect') {
      await env.AUTH_DB.prepare('DELETE FROM auth_state WHERE key = ?').bind(key).run();
      return reply({ connected: false });
    }
    const previous = await store.get(key);
    if (path === '/drive/connect') {
      if (typeof input.code !== 'string' || !input.code || input.code.length > 4096) return reply({ error: 'Invalid authorization code.' }, 400);
      const result = await googleToken(env, { grant_type: 'authorization_code', code: input.code, redirect_uri: origin }, fetcher);
      if (!(result.scope || '').split(' ').includes(DRIVE_SCOPE)) return reply({ error: 'Drive permission was not granted.' }, 403);
      const userResponse = await fetcher('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { authorization: 'Bearer ' + result.access_token }, signal: AbortSignal.timeout(15000)
      });
      const account = await boundedJson(userResponse, 16384);
      if (!userResponse.ok || !account.email_verified || String(account.email).toLowerCase() !== actor.email) return reply({ error: 'Choose the same Google account you use for the CRM.' }, 403);
      const old = previous && await unseal(env.CONNECTION_KEY, previous.credentials, key);
      const refreshToken = result.refresh_token || old?.refreshToken;
      if (!refreshToken) return reply({ error: 'Google did not grant a lasting connection. Reconnect Drive and approve access.' }, 409);
      await store.put(key, { credentials: await seal(env.CONNECTION_KEY, {
        refreshToken, accessToken: result.access_token, expiresAt: Date.now() + Number(result.expires_in) * 1000
      }, key) }, STORED_UNTIL);
      return reply({ connected: true, access_token: result.access_token, expires_in: Number(result.expires_in) });
    }
    if (!previous) return reply({ connected: false });
    const saved = await unseal(env.CONNECTION_KEY, previous.credentials, key);
    if (saved.expiresAt > Date.now() + 60000) return reply({ connected: true, access_token: saved.accessToken, expires_in: Math.floor((saved.expiresAt - Date.now()) / 1000) });
    let result;
    try { result = await googleToken(env, { grant_type: 'refresh_token', refresh_token: saved.refreshToken }, fetcher); }
    catch (error) {
      if (error.revoked) {
        // Do not invalidate a newer grant created while this request was in flight.
        await env.AUTH_DB.prepare('DELETE FROM auth_state WHERE key = ? AND payload = ?').bind(key, JSON.stringify(previous)).run();
        return reply({ connected: false });
      }
      throw error;
    }
    const credentials = await seal(env.CONNECTION_KEY, {
      refreshToken: result.refresh_token || saved.refreshToken, accessToken: result.access_token,
      expiresAt: Date.now() + Number(result.expires_in) * 1000
    }, key);
    const update = await env.AUTH_DB.prepare('UPDATE auth_state SET payload = ? WHERE key = ? AND payload = ? AND consumed = 0')
      .bind(JSON.stringify({ credentials }), key, JSON.stringify(previous)).run();
    if (update.meta.changes !== 1) return reply({ error: 'Drive connection changed. Try again.' }, 409);
    return reply({ connected: true, access_token: result.access_token, expires_in: Number(result.expires_in) });
  } catch {
    // Never expose provider responses, codes, credentials or request bodies.
    return reply({ error: 'Drive connection failed. Try again.' }, 502);
  }
}
