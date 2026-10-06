"use strict";
const { CLAUDE_REDIRECT_URI } = require("./lib");
const SCOPES = ["crm.tasks.write", "crm.records.read", "crm.records.write", "offline_access"];
function redirectUriAllowed(uri, extra = process.env.CHATGPT_REDIRECT_URIS || "") {
  // Exact callbacks only. Never accept arbitrary paths/subdomains or redirect wildcards.
  const allowed = new Set([CLAUDE_REDIRECT_URI, "https://chatgpt.com/connector_platform_oauth_redirect"]);
  for (const candidate of extra.split(",").map((v) => v.trim()).filter(Boolean)) {
    const u = new URL(candidate);
    if (u.origin !== "https://chatgpt.com" || !/^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname) || u.search || u.hash) throw new Error("CHATGPT_REDIRECT_URIS must contain exact official ChatGPT callbacks.");
    allowed.add(candidate);
  }
  return allowed.has(uri);
}
function requestedScopes(scope, redirectUri) {
  const values = String(scope || (redirectUri === CLAUDE_REDIRECT_URI ? "crm.tasks.write" : SCOPES.join(" "))).split(/\s+/).filter(Boolean);
  if (!values.length || values.some((value) => !SCOPES.includes(value))) throw new Error("Unsupported OAuth scope.");
  return [...new Set(values)].join(" ");
}
function hasScope(actor, scope) {
  // Tokens issued before this release retain task-only permissions.
  return String(actor.scope || "crm.tasks.write").split(/\s+/).includes(scope);
}
module.exports = { SCOPES, redirectUriAllowed, requestedScopes, hasScope };
