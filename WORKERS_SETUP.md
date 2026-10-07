# Ally CRM connector on Cloudflare Workers

This is the preferred alternative to the Firebase Functions deployment that required Blaze. It targets the existing Cloudflare account on Workers Free and the existing Firebase project. No billing upgrade, domain purchase, R2, service-account key or Firestore rules change is needed. Live workload must still fit the Free plan limits.

## Deploy from the existing Cloud Shell checkout

```bash
cd ~/ally-crm-go-live
git pull --ff-only origin main
cd workers
npm ci
npm test
npx wrangler login --device --scopes account:read user:read workers_scripts:write d1:write
npm run deploy
```

Complete Cloudflare's device authorization in your own browser with the account verified earlier. Do not paste credentials or the device code into chat. The script checks account membership, creates or reuses only `ally-crm-connector-auth` D1, applies its schema, deploys `ally-crm-connector`, creates an encrypted secret through stdin, and checks health. Existing encryption keys are preserved across deployments. Without the key, authentication routes fail closed.

Expected host, pending confirmation from deployment:
`https://ally-crm-connector.theallydamon.workers.dev`

If any command requests a billing upgrade, stop. A successful deployment and health check do not prove CRM access.

## Google authorization and private plugin

In Firebase Console, open project `ally-crm-cbdd1`, Authentication, Settings, Authorized domains. Add exactly `ally-crm-connector.theallydamon.workers.dev` so the existing Google sign-in can run on that host. Do not alter Firestore rules.

After the deployed URL is confirmed, update the private Ally Workflows plugin's MCP URL to that host plus `/mcp`. Reconnect and approve the CRM read/write permissions with the approved Google account. Connection consent performs a live CRM read before issuing credentials. Verify tool discovery and an authenticated read before declaring it live. Perform a write only against a record the user has authorized.

## Data and authorization

The Worker exposes `searchCrmRecords`, `getCrmRecord`, and `saveCrmRecord` across the seven existing boards. Read-only connections cannot invoke writes. Record writes use the existing validated core, source keys, request IDs, version checks and atomic Firestore preconditions.

OAuth clients, single-use grants and encrypted Firebase refresh credentials are stored in D1. Connections expire after 90 days. Revocation disables all tokens for that connection. The `/oauth/revoke` endpoint is advertised in OAuth metadata. Losing or replacing `CONNECTION_KEY` requires reconnecting; do not rotate it casually.

CRM records remain in the existing Firestore workspace. The operation ledger lives in the existing signed-in user's own `users/<uid>` document, with an update mask preserving other fields. Both changes commit atomically. This prevents normal whole-workspace saves in the CRM from erasing duplicate protection. The user document must already exist. Ledger capacity is 1,000 operations per user; reaching it stops writes for maintenance rather than silently discarding replay protection.

Credential refresh revalidates the Google identity on every CRM tool call. Only the two existing approved emails can connect. Host credentials grant the account's existing Firebase permissions; public tool inputs cannot select arbitrary document paths or bypass board validation.

## Verification and remaining work

Local checks: 18 existing backend tests, 14 Worker tests and one bundled workerd test. Workerd runs real Worker crypto, D1 and OAuth while Google services are mocked. These checks do not establish live Firebase access or production CPU consumption. CI repeats the checks with Node 22.

Private workflow instructions and plugin packaging are kept outside this public repository. Updating their endpoint happens after deployment verification. HubSpot synchronization is a workflow step using the connected HubSpot tools, not implemented by this Worker. Background Gmail ingestion is not enabled here. The daily cron only cleans up expired authentication state.
