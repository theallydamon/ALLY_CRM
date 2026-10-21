import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHandler } from './worker.mjs';
import { Store, sha256, seal, unseal } from './store.mjs';

const BASE = 'https://ally-crm-connector.theallydamon.workers.dev';
const ORIGIN = 'https://www.theallydamon.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('./migrations/0001_auth.sql', import.meta.url), 'utf8'));
  const statement = (query, values = []) => ({ bind(...v) { return statement(query, v); },
    async first() { return sql.prepare(query).get(...values) || null; },
    async run() { const r = sql.prepare(query).run(...values); return { meta: { changes: r.changes } }; } });
  const env = { AUTH_DB: { prepare: statement }, CONNECTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    FIREBASE_PROJECT: 'ally-crm-cbdd1', FIREBASE_SERVER_API_KEY: 'server-key', PUBLIC_ORIGIN: BASE, DRIVE_CLIENT_SECRET: 'fixture-secret' };
  const claims = { aud: env.FIREBASE_PROJECT, iss: 'https://securetoken.google.com/' + env.FIREBASE_PROJECT,
    sub: 'owner', exp: Math.floor(Date.now() / 1000) + 3600, auth_time: Math.floor(Date.now() / 1000) };
  const id = 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
  const calls = [];
  let account = 'theallydamon@gmail.com', scope = SCOPE, revoked = false, failRefresh = false, refreshCount = 0;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fetcher = async (url, options) => {
    calls.push(url);
    if (url.includes('identitytoolkit')) {
      if (JSON.parse(options.body).idToken !== id) return json({}, 400);
      return json({ users: [{ localId: 'owner', email: 'theallydamon@gmail.com', emailVerified: true }] });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const fields = new URLSearchParams(options.body);
      assert.equal(fields.get('client_secret'), env.DRIVE_CLIENT_SECRET);
      if (fields.get('grant_type') === 'authorization_code') {
        assert.equal(fields.get('redirect_uri'), ORIGIN);
        assert.equal(fields.get('code'), 'fixture-code');
        return json({ access_token: 'access-first', refresh_token: 'refresh-private', expires_in: 3600, scope });
      }
      assert.equal(fields.get('refresh_token'), 'refresh-private'); refreshCount++;
      if (revoked) return json({ error: 'invalid_grant' }, 400);
      if (failRefresh) return json({ error: 'temporarily_unavailable' }, 503);
      return json({ access_token: 'access-renewed', refresh_token: 'refresh-rotated', expires_in: 3600 });
    }
    if (url.includes('userinfo')) return json({ email: account, email_verified: true });
    throw new Error('Unexpected request');
  };
  const handler = createHandler(fetcher), store = new Store(env.AUTH_DB), key = 'drive:' + sha256('owner');
  async function request(path, { method = 'POST', origin = ORIGIN, token = id, custom = 'AllyCRM', body = {} } = {}) {
    const response = await handler(new Request(BASE + path, { method,
      headers: { Origin: origin, Authorization: 'Bearer ' + token, 'X-Requested-With': custom, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), env);
    const text = await response.text(); return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }
  async function expire() {
    const row = await store.get(key), saved = await unseal(env.CONNECTION_KEY, row.credentials, key);
    saved.expiresAt = 0; await store.put(key, { credentials: await seal(env.CONNECTION_KEY, saved, key) }, 8640000000000000);
  }
  return { env, sql, calls, request, store, key, expire, get refreshCount() { return refreshCount; },
    set account(v) { account = v; }, set scope(v) { scope = v; }, set revoked(v) { revoked = v; }, set failRefresh(v) { failRefresh = v; } };
}

test('Drive endpoints reject other origins, missing auth and missing CSRF header; preflight is restricted', async () => {
  const h = fixture();
  assert.equal((await h.request('/drive/token', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.request('/drive/token', { token: 'invalid' })).status, 401);
  assert.equal((await h.request('/drive/token', { custom: '' })).status, 400);
  const preflight = await h.request('/drive/token', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(h.calls.length, 1);
});
test('first consent encrypts credentials and reopening returns access without another grant', async () => {
  const h = fixture(); assert.deepEqual((await h.request('/drive/token')).body, { connected: false });
  const first = await h.request('/drive/connect', { body: { code: 'fixture-code' } });
  assert.equal(first.status, 200); assert.equal(first.body.access_token, 'access-first');
  assert(!JSON.stringify(first.body).includes('refresh'));
  const raw = h.sql.prepare('SELECT payload FROM auth_state WHERE key = ?').get(h.key).payload;
  assert(!raw.includes('refresh-private')); assert(!raw.includes('access-first'));
  const reopened = await h.request('/drive/token');
  assert.equal(reopened.body.access_token, 'access-first'); assert.equal(h.refreshCount, 0);
  assert.equal(reopened.headers.get('cache-control'), 'no-store');
});
test('expired access renews with the saved refresh token and retains rotation securely', async () => {
  const h = fixture(); await h.request('/drive/connect', { body: { code: 'fixture-code' } }); await h.expire();
  const result = await h.request('/drive/token'); assert.equal(result.body.access_token, 'access-renewed');
  assert.equal(h.refreshCount, 1);
  const row = await h.store.get(h.key), saved = await unseal(h.env.CONNECTION_KEY, row.credentials, h.key);
  assert.equal(saved.refreshToken, 'refresh-rotated');
});
test('wrong Google account or denied Drive scope cannot create a connection', async () => {
  for (const change of ['account', 'scope']) {
    const h = fixture(); h[change] = change === 'account' ? 'someone@example.com' : 'openid email';
    assert.equal((await h.request('/drive/connect', { body: { code: 'fixture-code' } })).status, 403);
    assert.equal(await h.store.get(h.key), null);
  }
});
test('revocation disconnects, while a temporary Google outage preserves the saved grant', async () => {
  for (const revoked of [true, false]) {
    const h = fixture(); await h.request('/drive/connect', { body: { code: 'fixture-code' } }); await h.expire();
    h.revoked = revoked; h.failRefresh = !revoked;
    const result = await h.request('/drive/token');
    assert.equal(result.status, revoked ? 200 : 502);
    assert.equal(Boolean(await h.store.get(h.key)), !revoked);
  }
});
test('disconnect removes the stored grant; unconfigured deployments fail closed', async () => {
  const h = fixture(); await h.request('/drive/connect', { body: { code: 'fixture-code' } });
  assert.equal((await h.request('/drive/disconnect')).body.connected, false);
  assert.equal((await h.request('/drive/token')).body.connected, false);
  delete h.env.DRIVE_CLIENT_SECRET;
  assert.equal((await h.request('/drive/connect', { body: { code: 'fixture-code' } })).status, 503);
});
