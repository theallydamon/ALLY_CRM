"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { saveRecord, searchRecords, version, records } = require("./crm-records");
const { redirectUriAllowed, requestedScopes, hasScope } = require("./crm-auth");
const { makeService } = require("./crm-service");
const seed = () => ({ ally: { lifeAdmin: { items: [] }, content: { cadence: 3, items: [] }, deals: { deals: [], clients: [{ id: "client", notes: "keep" }] }, song: { stages: [{ id: "s1", name: "Record vocals", status: "active" }] } }, mama: { tasks: [{ id: "work", title: "Keep this" }] }, untouched: { nested: "keep" } });
const create = (board, fields = {}) => ({ board, requestId: "operation", fields: { sourceKey: "thread:123", ...(board === "deals" ? { brand: "Roman's Pizza" } : { title: "Collect parcel" }), ...fields } });
test("create respects app schemas and preserves unrelated records", () => {
  const ws = seed();
  const saved = saveRecord(ws, create("brandContent", { description: "<script>untrusted</script>", sourceUrl: "https://mail.google.com/mail/u/0/#all/123" }), Date.parse("2026-10-06T23:00:00Z"), "fixed");
  assert.equal(saved.result.record.status, "Ideas");
  assert.equal(saved.result.record.descHtml, false);
  assert.equal(saved.result.record.desc, "<script>untrusted</script>");
  assert.equal(saved.result.record.created, "2026-10-07");
  assert.equal(saved.result.record.links[0].label, "Source");
  assert.deepEqual(saved.workspace.mama, ws.mama);
  assert.deepEqual(saved.workspace.untouched, ws.untouched);
  assert.equal(ws.ally.brandContent, undefined);
});
test("stable source keys prevent duplicates without overwriting manual changes", () => {
  const first = saveRecord(seed(), create("lifeAdmin"), 0, "task");
  first.result.record.description = "Manual note";
  const again = saveRecord(first.workspace, create("lifeAdmin", { description: "Changed" }));
  assert.equal(again.result.duplicate, true);
  assert.equal(again.result.record.description, "Manual note");
  assert.equal(records(again.workspace, "lifeAdmin").length, 1);
});
test("fresh-version sparse updates preserve context; stale and missing IDs fail", () => {
  const first = saveRecord(seed(), create("lifeAdmin", { description: "Manual details", due: "2026-10-10" }), 0, "task");
  const input = { board: "lifeAdmin", id: "task", expectedVersion: first.result.version, fields: { status: "Done" } };
  const next = saveRecord(first.workspace, input, 123);
  assert.equal(next.result.record.description, "Manual details");
  assert.equal(next.result.record.due, "2026-10-10");
  assert.equal(next.result.record.doneAt, 123);
  assert.throws(() => saveRecord(next.workspace, input), /Record changed/);
  assert.throws(() => saveRecord(next.workspace, { ...input, id: "missing" }), /no longer exists/);
});
test("invalid boards, unsafe fields, invalid dates and URLs cannot be written", () => {
  for (const board of ["__proto__", "constructor", "users", "_integrations"]) assert.throws(() => saveRecord(seed(), create(board)), /Unsupported/);
  for (const fields of [{ id: "override" }, { due: "2026-02-30" }, { due: "yesterday" }, { priority: "Urgent" }, { sourceUrl: "javascript:alert(1)" }, { status: "Accepted" }]) assert.throws(() => saveRecord(seed(), create("lifeAdmin", fields)));
  assert.throws(() => saveRecord(seed(), { board: "lifeAdmin", fields: { title: "No key" } }), /sourceKey/);
  assert.throws(() => saveRecord(seed(), { board: "songStages", fields: { name: "New song stage" } }), /not created/);
});
test("prospects stay prospects and stage dates merge without loss", () => {
  const first = saveRecord(seed(), create("deals", { stageDue: { script: "2026-10-08", post: "2026-10-12" }, notes: "Terms" }), 0, "deal");
  assert.equal(first.result.record.type, "Prospect");
  const next = saveRecord(first.workspace, { board: "deals", id: "deal", expectedVersion: first.result.version, fields: { type: "Active", stage: "approval", stageDue: { script: null } } });
  assert.deepEqual(next.result.record.stageDue, { script: null, post: "2026-10-12" });
  assert.equal(next.result.record.notes, "Terms");
  assert.deepEqual(next.workspace.ally.deals.clients, [{ id: "client", notes: "keep" }]);
});
test("search is bounded and paginated; versions ignore property order", () => {
  const ws = seed();
  ws.ally.lifeAdmin.items = Array.from({ length: 60 }, (_, i) => ({ id: String(i), title: "Parcel " + i }));
  const page = searchRecords(ws, { board: "lifeAdmin", query: "parcel", limit: 20 });
  assert.equal(page.total, 60); assert.equal(page.results.length, 20); assert.equal(page.nextOffset, 20);
  assert.equal(searchRecords(ws, { board: "lifeAdmin", offset: 40, limit: 20 }).nextOffset, null);
  assert.throws(() => searchRecords(ws, { limit: 51 }));
  assert.equal(version({ a: 1, b: 2 }), version({ b: 2, a: 1 }));
});
test("OAuth callbacks are exact; old tokens retain task-only scopes", () => {
  assert.equal(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(redirectUriAllowed("https://chatgpt.com/connector_platform_oauth_redirect"), true);
  assert.equal(redirectUriAllowed("https://chatgpt.com.evil.example/connector_platform_oauth_redirect"), false);
  assert.equal(redirectUriAllowed("https://chatgpt.com/connector/oauth/unknown", ""), false);
  assert.equal(redirectUriAllowed("https://chatgpt.com/connector/oauth/exact", "https://chatgpt.com/connector/oauth/exact"), true);
  assert.equal(redirectUriAllowed("https://chatgpt.com/connector/oauth/exact?evil=1", "https://chatgpt.com/connector/oauth/exact"), false);
  assert.equal(hasScope({}, "crm.records.write"), false);
  assert.equal(hasScope({}, "crm.tasks.write"), true);
  assert.equal(requestedScopes("", "https://claude.ai/api/mcp/auth_callback"), "crm.tasks.write");
  assert.throws(() => requestedScopes("admin", "https://chatgpt.com/connector_platform_oauth_redirect"));
});
function fakeDb(workspace) {
  const data = new Map([["workspace", workspace]]);
  const ref = (key) => ({ key, collection: (name) => ({ doc: (id) => ref(key + "/" + name + "/" + id) }), get: async () => snap(key) });
  const snap = (key) => ({ exists: data.has(key), data: () => data.get(key) });
  const db = { runTransaction: async (fn) => {
    const writes = [];
    const result = await fn({ get: async (r) => snap(r.key), set: (r, value) => writes.push([r.key, value]) });
    writes.forEach(([key, value]) => data.set(key, value));
    return result;
  } };
  return { data, call: makeService(db, ref("workspace"), ref("integration"), () => "server-time") };
}
test("transaction replay is idempotent; reusing operation ID for other input fails", async () => {
  const fake = fakeDb(seed());
  const args = create("lifeAdmin");
  const first = await fake.call("saveCrmRecord", args, "owner@example.com");
  const replay = await fake.call("saveCrmRecord", args, "owner@example.com");
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.id, first.record.id);
  assert.equal(fake.data.get("workspace").ally.lifeAdmin.items.length, 1);
  await assert.rejects(fake.call("saveCrmRecord", { ...args, fields: { ...args.fields, title: "Different" } }, "owner@example.com"), /different arguments/);
});
test("failed transaction writes neither workspace nor replay record", async () => {
  const fake = fakeDb(seed());
  await assert.rejects(fake.call("saveCrmRecord", create("lifeAdmin", { due: "2026-02-30" }), "owner"), /real/);
  assert.equal(fake.data.size, 1);
  assert.equal(fake.data.get("workspace").ally.lifeAdmin.items.length, 0);
});
