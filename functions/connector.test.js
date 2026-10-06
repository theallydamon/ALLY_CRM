"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const { sha256 } = require("./lib");
const ISSUER = "https://us-central1-ally-crm-cbdd1.cloudfunctions.net/crmConnector";
function harness() {
  const data = new Map([["workspaces/ally-crm", { ally: { lifeAdmin: { items: [] } }, mama: { tasks: [] } }]]);
  const snapshot = (key) => ({ exists: data.has(key), data: () => data.get(key) });
  const ref = (key) => ({
    key, get: async () => snapshot(key), set: async (value) => data.set(key, value), delete: async () => data.delete(key),
    collection: (name) => ({ doc: (id) => ref(key + "/" + name + "/" + id) }),
  });
  const db = { doc: ref, collection: (name) => ({ doc: (id) => ref(name + "/" + id) }) };
  let queue = Promise.resolve();
  db.runTransaction = (fn) => {
    const result = queue.then(async () => {
      const writes = [];
      const value = await fn({ get: async (r) => snapshot(r.key), set: (r, value) => writes.push(() => data.set(r.key, value)), delete: (r) => writes.push(() => data.delete(r.key)) });
      writes.forEach((write) => write());
      return value;
    });
    queue = result.catch(() => {});
    return result;
  };
  db.batch = () => {
    const writes = [];
    return { set: (r, value) => writes.push(() => data.set(r.key, value)), delete: (r) => writes.push(() => data.delete(r.key)), commit: async () => writes.forEach((write) => write()) };
  };
  const context = {
    exports: {}, URL, URLSearchParams, Buffer, process: { env: { GCLOUD_PROJECT: "ally-crm-cbdd1" } }, console,
    require: (name) => {
      if (name === "firebase-functions/v2/https") return { onRequest: (_options, handler) => handler };
      if (name === "firebase-admin/app") return { initializeApp() {} };
      if (name === "firebase-admin/auth") return { getAuth: () => ({ verifyIdToken: async (token) => {
        if (token !== "approved-fixture") throw new Error("Invalid token");
        return { email: "theallydamon@gmail.com", email_verified: true };
      } }) };
      if (name === "firebase-admin/firestore") return { getFirestore: () => db, FieldValue: { serverTimestamp: () => "timestamp" } };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(__dirname + "/index.js", "utf8"), context);
  async function request(path, { method = "POST", body = {}, query = {}, token } = {}) {
    const result = { statusCode: 200, headers: {} };
    const res = {
      status: (code) => { result.statusCode = code; return res; },
      set: (key, value) => { result.headers[key] = value; return res; },
      json: (body) => { result.body = JSON.parse(JSON.stringify(body)); return res; },
      send: (body) => { result.body = body; return res; },
      end: () => res,
      redirect: (code, url) => { result.statusCode = code; result.headers.Location = url; return res; },
    };
    await context.exports.crmConnector({ path, method, body, query, protocol: "https", get: (key) => key === "host" ? "us-central1-ally-crm-cbdd1.cloudfunctions.net" : key === "authorization" && token ? "Bearer " + token : "" }, res);
    return result;
  }
  const rpc = (method, params, token) => request("/mcp", { token, body: { jsonrpc: "2.0", id: 1, method, params } });
  return { data, request, rpc };
}
async function login(h, scope = "crm.records.read crm.records.write offline_access") {
  const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
  const registration = await h.request("/oauth/register", { body: { redirect_uris: [redirect], client_name: "Fixture" } });
  assert.equal(registration.statusCode, 201);
  const client = registration.body;
  const verifier = "fixture-verifier-abcdefghijklmnopqrstuvwxyz-1234567890";
  const challenge = Buffer.from(sha256(verifier), "hex").toString("base64url");
  const authorized = await h.request("/oauth/authorize", { method: "GET", query: { response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", scope, resource: ISSUER + "/mcp", state: "fixture-state" } });
  assert.equal(authorized.statusCode, 200);
  assert.match(authorized.body, /read CRM records/);
  const pendingId = [...h.data.keys()].find((key) => key.includes("/pending/")).split("/").at(-1);
  const approval = await h.request("/oauth/approve", { body: { pendingId, idToken: "approved-fixture" } });
  const callback = new URL(approval.body.redirect);
  assert.equal(callback.searchParams.get("iss"), ISSUER);
  assert.equal(callback.searchParams.get("state"), "fixture-state");
  const exchange = { grant_type: "authorization_code", client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirect, code: callback.searchParams.get("code"), code_verifier: verifier, resource: ISSUER + "/mcp" };
  const token = await h.request("/oauth/token", { body: exchange });
  assert.equal(token.statusCode, 200);
  return { token: token.body.access_token, refresh: token.body.refresh_token, client, exchange };
}
test("complete OAuth -> tool discovery -> CRM save -> read flow", async () => {
  const h = harness(), session = await login(h);
  const listed = await h.rpc("tools/list", {}, session.token);
  assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ["searchCrmRecords", "getCrmRecord", "saveCrmRecord"]);
  const written = await h.rpc("tools/call", { name: "saveCrmRecord", arguments: { board: "lifeAdmin", requestId: "fixture-write", fields: { title: "Call courier", sourceKey: "fixture:courier" } } }, session.token);
  assert.equal(written.body.result.structuredContent.created, true);
  const id = written.body.result.structuredContent.record.id;
  const read = await h.rpc("tools/call", { name: "getCrmRecord", arguments: { board: "lifeAdmin", id } }, session.token);
  assert.equal(read.body.result.structuredContent.record.title, "Call courier");
  const repeated = await h.request("/oauth/token", { body: session.exchange });
  assert.equal(repeated.statusCode, 400);
});
test("read-only tokens cannot call writes, even by undiscovered tool name", async () => {
  const h = harness(), session = await login(h, "crm.records.read");
  const listed = await h.rpc("tools/list", {}, session.token);
  assert.equal(listed.body.result.tools.length, 2);
  const written = await h.rpc("tools/call", { name: "saveCrmRecord", arguments: {} }, session.token);
  assert.equal(written.body.result.isError, true);
  assert.match(written.body.result.content[0].text, /Missing crm.records.write/);
  assert.equal(h.data.get("workspaces/ally-crm").ally.lifeAdmin.items.length, 0);
});
test("legacy Claude tokens can only discover and call legacy task tool", async () => {
  const h = harness();
  h.data.set("_integrations/claude-inbox/tokens/" + sha256("legacy"), { kind: "access", email: "theallydamon@gmail.com", expiresAt: Date.now() + 10000 });
  const listed = await h.rpc("tools/list", {}, "legacy");
  assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ["logCrmTask"]);
  const search = await h.rpc("tools/call", { name: "searchCrmRecords", arguments: {} }, "legacy");
  assert.equal(search.body.result.isError, true);
  const logged = await h.rpc("tools/call", { name: "logCrmTask", arguments: { profile: "personal", title: "Legacy task", sourceMessageId: "gmail-fixture" } }, "legacy");
  assert.equal(logged.body.result.structuredContent.created, true);
});
test("refresh rotates once, preserving scope and resource", async () => {
  const h = harness(), session = await login(h);
  const body = { grant_type: "refresh_token", client_id: session.client.client_id, client_secret: session.client.client_secret, refresh_token: session.refresh, resource: ISSUER + "/mcp" };
  const responses = await Promise.all([h.request("/oauth/token", { body }), h.request("/oauth/token", { body })]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 400]);
  const success = responses.find((r) => r.statusCode === 200);
  assert.equal(success.body.scope, "crm.records.read crm.records.write offline_access");
});
test("metadata, unauthenticated challenges and wrong audiences", async () => {
  const h = harness();
  const metadata = await h.request("/.well-known/oauth-authorization-server", { method: "GET" });
  assert.equal(metadata.body.issuer, ISSUER);
  assert.equal(metadata.body.authorization_response_iss_parameter_supported, true);
  assert.equal((await h.rpc("tools/list", {})).statusCode, 401);
  assert.equal((await h.request("/mcp", { method: "GET" })).statusCode, 405);
  h.data.set("_integrations/claude-inbox/tokens/" + sha256("wrong"), { kind: "access", email: "theallydamon@gmail.com", scope: "crm.records.read", resource: "https://other.example/mcp", expiresAt: Date.now() + 10000 });
  assert.equal((await h.rpc("tools/list", {}, "wrong")).statusCode, 401);
  const registration = await h.request("/oauth/register", { body: { redirect_uris: ["https://attacker.example/callback"] } });
  assert.equal(registration.statusCode, 400);
});
