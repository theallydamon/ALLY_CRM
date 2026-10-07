import { timingSafeEqual } from 'node:crypto';
import lib from '../functions/lib.js';
export const { sha256, randomToken, ALLOWED_EMAILS } = lib;
export function secretEqual(a, b) {
  return timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
}
export class Store {
  constructor(db) { this.db = db; }
  async get(key) {
    const row = await this.db.prepare('SELECT payload FROM auth_state WHERE key = ? AND expires > ? AND consumed = 0').bind(key, Date.now()).first();
    return row ? JSON.parse(row.payload) : null;
  }
  async put(key, value, expires) {
    await this.db.prepare('INSERT INTO auth_state(key,payload,expires,consumed) VALUES(?,?,?,0) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,expires=excluded.expires,consumed=0').bind(key, JSON.stringify(value), expires).run();
  }
  async updateSession(key, value) {
    const result = await this.db.prepare('UPDATE auth_state SET payload = ? WHERE key = ? AND expires > ? AND consumed = 0').bind(JSON.stringify(value), key, Date.now()).run();
    return result.meta.changes === 1;
  }
  async claim(key) {
    const row = await this.db.prepare('UPDATE auth_state SET consumed = 1 WHERE key = ? AND expires > ? AND consumed = 0 RETURNING payload').bind(key, Date.now()).first();
    return row ? JSON.parse(row.payload) : null;
  }
  async putTokens(access, refresh, actor, expires) {
    const statement = (key, payload, expiry) => this.db.prepare('INSERT INTO auth_state(key,payload,expires) VALUES(?,?,?)').bind(key, JSON.stringify(payload), expiry);
    await this.db.batch([
      statement('token:' + sha256(access), { ...actor, kind: 'access' }, Math.min(Date.now() + 3600000, expires)),
      statement('token:' + sha256(refresh), { ...actor, kind: 'refresh' }, expires)
    ]);
  }
  async limit(key, max = 60) {
    const window = Math.floor(Date.now() / 3600000);
    const row = await this.db.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key + ':' + window, (window + 2) * 3600000).first();
    return row.count <= max;
  }
}
async function encryptionKey(secret) {
  const bytes = Buffer.from(secret || '', 'base64');
  if (bytes.length !== 32) throw new Error('Connection encryption secret is missing or invalid.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(secret, value, sessionId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(sessionId) }, await encryptionKey(secret), new TextEncoder().encode(JSON.stringify(value)));
  return Buffer.concat([Buffer.from(iv), Buffer.from(encrypted)]).toString('base64');
}
export async function unseal(secret, value, sessionId) {
  const data = Buffer.from(value, 'base64');
  const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: new TextEncoder().encode(sessionId) }, await encryptionKey(secret), data.subarray(12));
  return JSON.parse(new TextDecoder().decode(decoded));
}
