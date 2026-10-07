import { ALLOWED_EMAILS, seal, unseal } from './store.mjs';
class FirestoreValue {
  constructor(raw) { this.raw = raw; }
  toJSON() { return this.raw; }
}
export const timestamp = value => new FirestoreValue({ timestampValue: value });
export function decode(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('integerValue' in value && Number.isSafeInteger(Number(value.integerValue))) return Number(value.integerValue);
  if ('doubleValue' in value && typeof value.doubleValue === 'number' && Number.isFinite(value.doubleValue)) return value.doubleValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, field]) => [key, decode(field)]));
  // Preserve timestamps, references, bytes, GeoPoints, large integers and special doubles verbatim.
  return new FirestoreValue(value);
}
export function encode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (value && typeof value === 'object') {
    if (value instanceof FirestoreValue) return value.raw;
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, field]) => [key, encode(field)])) } };
  }
  throw new Error('Unsupported Firestore field value.');
}
export async function boundedJson(response, max = 4 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty backend response.');
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new Error('Backend response exceeds safe size limit.'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function google(env, path, body, fetcher) {
  const response = await fetcher('https://identitytoolkit.googleapis.com/v1/' + path + '?key=' + encodeURIComponent(env.FIREBASE_API_KEY), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  const result = await boundedJson(response, 128 * 1024);
  if (!response.ok) throw new Error('Google sign-in is invalid or expired. Reconnect.');
  return result;
}
export async function verifyIdentity(env, idToken, fetcher = (input, init) => fetch(input, init)) {
  const result = await google(env, 'accounts:lookup', { idToken }, fetcher);
  const user = result.users?.[0];
  if (!user || user.disabled || !user.emailVerified || !ALLOWED_EMAILS.has(String(user.email).toLowerCase())) throw new Error('This account is not approved for ALLY CRM.');
  // The API validates the ID token. These additional checks reject wrong projects and revocation.
  const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  if (claims.aud !== env.FIREBASE_PROJECT || claims.iss !== 'https://securetoken.google.com/' + env.FIREBASE_PROJECT || claims.sub !== user.localId || (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) || Number(user.validSince || 0) > Number(claims.auth_time || 0)) throw new Error('Google identity is expired, revoked, or belongs to another project.');
  return { email: String(user.email).toLowerCase(), uid: user.localId };
}
export async function exchangeFirebase(env, refreshToken, fetcher = (input, init) => fetch(input, init)) {
  const response = await fetcher('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(env.FIREBASE_API_KEY), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(), signal: AbortSignal.timeout(15000)
  });
  const result = await boundedJson(response, 128 * 1024);
  if (!response.ok || !result.id_token || !result.refresh_token || result.project_id !== '139362174943') throw new Error('Firebase connection expired. Reconnect with Google.');
  return result;
}
export async function sessionToken(env, store, actor, fetcher = (input, init) => fetch(input, init)) {
  const session = await store.get('session:' + actor.sessionId);
  if (!session || session.email !== actor.email) throw new Error('CRM connection expired. Reconnect.');
  const credentials = await unseal(env.CONNECTION_KEY, session.credentials, actor.sessionId);
  const exchanged = await exchangeFirebase(env, credentials.refreshToken, fetcher);
  const identity = await verifyIdentity(env, exchanged.id_token, fetcher);
  if (identity.email !== actor.email || identity.uid !== session.uid) throw new Error('CRM connection identity mismatch. Reconnect.');
  // Refresh rotation is retained without extending the original approved connection lifetime.
  if (!await store.updateSession('session:' + actor.sessionId, { ...session, credentials: await seal(env.CONNECTION_KEY, { refreshToken: exchanged.refresh_token }, actor.sessionId) })) throw new Error('CRM connection revoked. Reconnect.');
  return exchanged.id_token;
}
export class Workspace {
  constructor(env, token, fetcher = (input, init) => fetch(input, init), uid) {
    if (env.FIREBASE_PROJECT !== 'ally-crm-cbdd1') throw new Error('Unexpected Firebase project.');
    this.url = 'https://firestore.googleapis.com/v1/projects/ally-crm-cbdd1/databases/(default)/documents/workspaces/ally-crm';
    this.token = token; this.fetcher = fetcher;
    this.database = 'projects/ally-crm-cbdd1/databases/(default)';
    if (typeof uid !== 'string' || !uid || /[\/]/.test(uid)) throw new Error('Invalid Firebase identity.');
    this.userPath = this.database + '/documents/users/' + uid;
  }
  async read() {
    const response = await this.fetcher(this.url, { headers: { authorization: 'Bearer ' + this.token }, signal: AbortSignal.timeout(15000) });
    const body = await boundedJson(response);
    if (!response.ok || !body.fields || !body.updateTime) throw new Error('Live CRM could not be read. Check account permissions.');
    const data = decode({ mapValue: { fields: body.fields } });
    if (!data.ally || !data.mama) throw new Error('Unexpected CRM workspace shape.');
    return { data, updateTime: body.updateTime };
  }
  async history() {
    const response = await this.fetcher('https://firestore.googleapis.com/v1/' + this.userPath, { headers: { authorization: 'Bearer ' + this.token }, signal: AbortSignal.timeout(15000) });
    const body = await boundedJson(response);
    if (!response.ok || !body.updateTime) throw new Error('CRM owner document is missing or inaccessible. No write was made.');
    const operations = body.fields?._assistantOperations ? decode(body.fields._assistantOperations) : {};
    if (!operations || typeof operations !== 'object' || Array.isArray(operations)) throw new Error('Invalid operation history.');
    return { operations, updateTime: body.updateTime };
  }
  async write(data, updateTime, history) {
    const response = await this.fetcher('https://firestore.googleapis.com/v1/' + this.database + '/documents:commit', {
      method: 'POST', headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' },
      body: JSON.stringify({ writes: [
        { update: { name: this.database + '/documents/workspaces/ally-crm', fields: encode(data).mapValue.fields }, currentDocument: { updateTime } },
        { update: { name: this.userPath, fields: { _assistantOperations: encode(history.operations) } }, updateMask: { fieldPaths: ['_assistantOperations'] }, currentDocument: { updateTime: history.updateTime } }
      ] }), signal: AbortSignal.timeout(15000)
    });
    if (response.ok) { await response.body?.cancel(); return true; }
    const body = await boundedJson(response, 128 * 1024);
    if (body.error?.status === 'FAILED_PRECONDITION' || body.error?.status === 'ABORTED') return false;
    throw new Error('CRM write failed. No success is confirmed.');
  }
}
