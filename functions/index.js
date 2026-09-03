"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const {
  ALLOWED_EMAILS,
  CLAUDE_REDIRECT_URI,
  normaliseTask,
  randomToken,
  sha256,
  taskRecord,
} = require("./lib");

initializeApp();
const db = getFirestore();
const REGION = "us-central1";
const WORKSPACE = db.doc("workspaces/ally-crm");
const OAUTH = db.collection("_integrations").doc("claude-inbox");
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

/* Firebase's canonical functions URL includes the function name as a path component. Deriving an
   OAuth issuer from req.host alone would silently drop that component and publish broken discovery
   URLs. Keep one stable public issuer for Claude and use localhost only in the emulator. */
const originFor = (req) => {
  if (/^(localhost|127\.0\.0\.1)(:|$)/.test(req.get("host") || "")) return `${req.protocol}://${req.get("host")}`;
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "ally-crm-cbdd1";
  return `https://${REGION}-${projectId}.cloudfunctions.net/crmConnector`;
};
const json = (res, status, body) => res.status(status).set("Cache-Control", "no-store").json(body);
const oauthError = (res, status, error, description) => json(res, status, { error, error_description: description });

function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return Object.fromEntries(new URLSearchParams(req.rawBody ? req.rawBody.toString("utf8") : ""));
}

function redirectUriAllowed(uri) {
  return uri === CLAUDE_REDIRECT_URI;
}

async function authenticate(req) {
  const header = req.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const tokenHash = sha256(header.slice(7));
  const snap = await OAUTH.collection("tokens").doc(tokenHash).get();
  if (!snap.exists) return null;
  const token = snap.data();
  if (token.kind !== "access" || token.expiresAt <= Date.now() || !ALLOWED_EMAILS.has(token.email)) return null;
  return token;
}

async function issueTokens(email, clientId, oldRefreshHash = null) {
  const accessToken = randomToken(36);
  const refreshToken = randomToken(48);
  const batch = db.batch();
  batch.set(OAUTH.collection("tokens").doc(sha256(accessToken)), {
    kind: "access", email, clientId, expiresAt: Date.now() + ACCESS_TTL_MS, createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(OAUTH.collection("tokens").doc(sha256(refreshToken)), {
    kind: "refresh", email, clientId, expiresAt: Date.now() + REFRESH_TTL_MS, createdAt: FieldValue.serverTimestamp(),
  });
  if (oldRefreshHash) batch.delete(OAUTH.collection("tokens").doc(oldRefreshHash));
  await batch.commit();
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refreshToken, scope: "crm.tasks.write" };
}

async function registerClient(req, res) {
  const body = parseBody(req);
  const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!redirects.length || redirects.some((uri) => !redirectUriAllowed(uri))) {
    return oauthError(res, 400, "invalid_redirect_uri", "Only Claude's official MCP callback is allowed.");
  }
  const clientId = randomToken(24);
  const clientSecret = randomToken(36);
  await OAUTH.collection("clients").doc(clientId).set({
    clientSecretHash: sha256(clientSecret),
    redirectUris: redirects,
    clientName: String(body.client_name || "Claude").slice(0, 100),
    createdAt: FieldValue.serverTimestamp(),
  });
  return json(res, 201, {
    client_id: clientId,
    client_secret: clientSecret,
    client_secret_expires_at: 0,
    redirect_uris: redirects,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
}

async function authorize(req, res) {
  const q = req.query;
  if (q.response_type !== "code" || !q.client_id || !q.redirect_uri || !q.code_challenge || q.code_challenge_method !== "S256") {
    return res.status(400).send("Invalid OAuth request.");
  }
  const client = await OAUTH.collection("clients").doc(String(q.client_id)).get();
  if (!client.exists || !client.data().redirectUris.includes(String(q.redirect_uri)) || !redirectUriAllowed(String(q.redirect_uri))) {
    return res.status(400).send("Unknown OAuth client or redirect URI.");
  }
  const pendingId = randomToken(24);
  await OAUTH.collection("pending").doc(pendingId).set({
    clientId: String(q.client_id), redirectUri: String(q.redirect_uri), state: String(q.state || ""),
    codeChallenge: String(q.code_challenge), expiresAt: Date.now() + CODE_TTL_MS,
  });
  const approveUrl = `${originFor(req)}/oauth/approve`;
  return res.status(200).set("Content-Security-Policy", "default-src 'self' https://www.gstatic.com https://apis.google.com; script-src 'self' 'unsafe-inline' https://www.gstatic.com https://apis.google.com; frame-src https://accounts.google.com; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Claude to ALLY CRM</title>
<style>body{font:16px system-ui;max-width:520px;margin:12vh auto;padding:24px;color:#202124}button{border:0;border-radius:12px;padding:13px 18px;background:#202124;color:white;font-weight:650;cursor:pointer}.muted{color:#667085;font-size:14px}#error{color:#b42318}</style></head>
<body><h1>Connect ALLY CRM</h1><p>Sign in with an approved CRM account. Claude will receive permission only to add inbox tasks.</p><button id="connect">Continue with Google</button><p id="error"></p><p class="muted">No Google password or service-account key is shared with Claude.</p>
<script src="https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js"></script><script src="https://www.gstatic.com/firebasejs/12.15.0/firebase-auth-compat.js"></script>
<script>
firebase.initializeApp({apiKey:"AIzaSyBkjEWhqucPPFVCi5cnx_15LccgbI4B-pQ",authDomain:"ally-crm-cbdd1.firebaseapp.com",projectId:"ally-crm-cbdd1",appId:"1:139362174943:web:ea4df75838f6dfcf80a66a"});
document.getElementById("connect").onclick=async()=>{const e=document.getElementById("error");e.textContent="";try{const r=await firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider());const idToken=await r.user.getIdToken();const response=await fetch(${JSON.stringify(approveUrl)},{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pendingId:${JSON.stringify(pendingId)},idToken})});const data=await response.json();if(!response.ok)throw new Error(data.error||"Connection failed");location.href=data.redirect;}catch(err){e.textContent=err.message||"Connection failed";}};
</script></body></html>`);
}

async function approve(req, res) {
  const body = parseBody(req);
  const pendingRef = OAUTH.collection("pending").doc(String(body.pendingId || ""));
  const pending = await pendingRef.get();
  if (!pending.exists || pending.data().expiresAt <= Date.now()) return json(res, 400, { error: "This connection request expired." });
  let decoded;
  try { decoded = await getAuth().verifyIdToken(String(body.idToken || ""), true); } catch (_) { return json(res, 401, { error: "Google sign-in could not be verified." }); }
  const email = String(decoded.email || "").toLowerCase();
  if (!decoded.email_verified || !ALLOWED_EMAILS.has(email)) return json(res, 403, { error: "This Google account is not approved for ALLY CRM." });
  const code = randomToken(32);
  const data = pending.data();
  const batch = db.batch();
  batch.delete(pendingRef);
  batch.set(OAUTH.collection("codes").doc(sha256(code)), { ...data, email, expiresAt: Date.now() + CODE_TTL_MS });
  await batch.commit();
  const redirect = new URL(data.redirectUri); redirect.searchParams.set("code", code); if (data.state) redirect.searchParams.set("state", data.state);
  return json(res, 200, { redirect: redirect.toString() });
}

async function token(req, res) {
  const body = parseBody(req);
  const clientId = String(body.client_id || "");
  const client = await OAUTH.collection("clients").doc(clientId).get();
  if (!client.exists || sha256(String(body.client_secret || "")) !== client.data().clientSecretHash) return oauthError(res, 401, "invalid_client", "Client authentication failed.");
  if (body.grant_type === "authorization_code") {
    const codeHash = sha256(String(body.code || ""));
    const codeRef = OAUTH.collection("codes").doc(codeHash);
    const code = await codeRef.get();
    if (!code.exists) return oauthError(res, 400, "invalid_grant", "Authorization code is invalid.");
    const value = code.data();
    const challenge = Buffer.from(sha256(Buffer.from(String(body.code_verifier || ""))), "hex").toString("base64url");
    if (value.expiresAt <= Date.now() || value.clientId !== clientId || value.redirectUri !== body.redirect_uri || challenge !== value.codeChallenge) return oauthError(res, 400, "invalid_grant", "Authorization code verification failed.");
    await codeRef.delete();
    return json(res, 200, await issueTokens(value.email, clientId));
  }
  if (body.grant_type === "refresh_token") {
    const refreshHash = sha256(String(body.refresh_token || ""));
    const refresh = await OAUTH.collection("tokens").doc(refreshHash).get();
    if (!refresh.exists || refresh.data().kind !== "refresh" || refresh.data().clientId !== clientId || refresh.data().expiresAt <= Date.now()) return oauthError(res, 400, "invalid_grant", "Refresh token is invalid.");
    return json(res, 200, await issueTokens(refresh.data().email, clientId, refreshHash));
  }
  return oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
}

async function logCrmTask(args, actorEmail) {
  const input = normaliseTask(args);
  const dedupeId = sha256(`${input.profile}:${input.sourceMessageId}`);
  const dedupeRef = OAUTH.collection("loggedMessages").doc(dedupeId);
  return db.runTransaction(async (tx) => {
    const [workspaceSnap, duplicateSnap] = await Promise.all([tx.get(WORKSPACE), tx.get(dedupeRef)]);
    if (duplicateSnap.exists) return { created: false, duplicate: true, taskId: duplicateSnap.data().taskId, profile: input.profile };
    if (!workspaceSnap.exists) throw new Error("ALLY CRM workspace does not exist.");
    const workspace = workspaceSnap.data();
    if (!workspace.ally || !workspace.mama) throw new Error("ALLY CRM workspace has an unexpected shape.");
    const id = randomToken(9);
    const task = taskRecord(input, id);
    const next = { ...workspace };
    if (input.profile === "personal") {
      const lifeAdmin = workspace.ally.lifeAdmin || { items: [] };
      next.ally = { ...workspace.ally, lifeAdmin: { ...lifeAdmin, items: [task, ...(lifeAdmin.items || [])] } };
    } else {
      next.mama = { ...workspace.mama, tasks: [task, ...(workspace.mama.tasks || [])] };
    }
    tx.set(WORKSPACE, { ...next, workspaceId: "ally-crm", updatedAt: FieldValue.serverTimestamp(), updatedBy: `claude-inbox:${actorEmail}` });
    tx.set(dedupeRef, { taskId: id, profile: input.profile, sourceMessageIdHash: sha256(input.sourceMessageId), createdAt: FieldValue.serverTimestamp() });
    return { created: true, duplicate: false, taskId: id, profile: input.profile };
  });
}

async function mcp(req, res) {
  const actor = await authenticate(req);
  if (!actor) {
    return res.status(401).set("WWW-Authenticate", `Bearer resource_metadata=\"${originFor(req)}/.well-known/oauth-protected-resource\"`).json({ error: "unauthorized" });
  }
  const body = parseBody(req);
  const base = { jsonrpc: "2.0", id: body.id == null ? null : body.id };
  if (body.method === "initialize") return json(res, 200, { ...base, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ALLY CRM Inbox", version: "1.0.0" } } });
  if (body.method === "notifications/initialized") return res.status(202).end();
  if (body.method === "tools/list") return json(res, 200, { ...base, result: { tools: [{
    name: "logCrmTask",
    description: "Add one genuine actionable Gmail item to the correct live ALLY CRM task board. Use the Gmail message ID for idempotency. Do not use for FYIs, newsletters, receipts, marketing, calendar notices, or already-completed actions.",
    inputSchema: { type: "object", additionalProperties: false, required: ["profile", "title", "sourceMessageId"], properties: {
      profile: { type: "string", enum: ["personal", "work"], description: "work for MAMA business; personal for everything else" },
      title: { type: "string", maxLength: 240 }, description: { type: "string", maxLength: 4000 },
      dueDate: { type: ["string", "null"], description: "YYYY-MM-DD only when the email states a real deadline" },
      priority: { type: "string", enum: ["Low", "Medium", "High"], default: "Medium" },
      sourceMessageId: { type: "string", maxLength: 500, description: "Stable Gmail message ID; required to prevent duplicate tasks" },
      sourceUrl: { type: "string", maxLength: 2000, description: "Optional HTTPS Gmail permalink" },
    } },
  }] } });
  if (body.method === "tools/call" && body.params && body.params.name === "logCrmTask") {
    try {
      const result = await logCrmTask(body.params.arguments, actor.email);
      return json(res, 200, { ...base, result: { content: [{ type: "text", text: result.created ? `Task logged in ${result.profile} ALLY CRM (${result.taskId}).` : `Already logged; no duplicate created (${result.taskId}).` }], structuredContent: result } });
    } catch (error) {
      return json(res, 200, { ...base, result: { isError: true, content: [{ type: "text", text: error.message || "Task could not be logged." }] } });
    }
  }
  return json(res, 200, { ...base, error: { code: -32601, message: "Method not found" } });
}

exports.crmConnector = onRequest({ region: REGION, cors: false, invoker: "public", maxInstances: 3, timeoutSeconds: 30 }, async (req, res) => {
  try {
    const path = req.path.replace(/\/$/, "") || "/";
    const origin = originFor(req);
    if (req.method === "GET" && path === "/.well-known/oauth-protected-resource") return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["crm.tasks.write"] });
    if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")) return json(res, 200, {
      issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"], scopes_supported: ["crm.tasks.write"],
    });
    if (req.method === "POST" && path === "/oauth/register") return registerClient(req, res);
    if (req.method === "GET" && path === "/oauth/authorize") return authorize(req, res);
    if (req.method === "POST" && path === "/oauth/approve") return approve(req, res);
    if (req.method === "POST" && path === "/oauth/token") return token(req, res);
    if (req.method === "POST" && (path === "/mcp" || path === "/")) return mcp(req, res);
    if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, service: "ALLY CRM Inbox connector" });
    return json(res, 404, { error: "not_found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "internal_error" });
  }
});
