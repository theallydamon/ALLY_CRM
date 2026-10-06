# Ally Workflows

The plugin provides two skills: brand-opportunities and record-in-crm. Gmail and HubSpot are verified existing app dependencies. The remote MCP connection reuses the existing Firebase crmConnector function; no new database or Sheet is required.

## Deployment

GitHub Pages only deploys the website. A push or merge does not deploy Firebase functions.

From a machine or Cloud Shell already signed in to the Firebase project:

1. Fetch this repository's latest main branch.
2. Use Node 22, then run npm ci in functions/.
3. Run node --test in functions/.
4. From the repository root, run the official Firebase CLI:

   npx firebase-tools deploy --only functions:crmConnector --project ally-crm-cbdd1

Use Firebase's normal login flow when needed; never paste tokens, service-account keys or passwords into chat. Deploy only this function. Do not change Firestore rules, website authentication or the project billing plan as part of this update.

The existing project must already support Cloud Functions deployment. If billing or IAM blocks deployment, report the exact error rather than changing permissions or billing automatically.

Expected health endpoint:

https://us-central1-ally-crm-cbdd1.cloudfunctions.net/crmConnector/health

Expected MCP endpoint:

https://us-central1-ally-crm-cbdd1.cloudfunctions.net/crmConnector/mcp

These URLs are grounded in the existing function source, not proof of live deployment. The new health response must include version 2.0.0 before connecting the plugin.

## Connection

Install/enable the private Ally Workflows plugin and complete its Google authorization with an approved existing CRM account. Read the consent screen: the new connection allows reading and creating/updating supported CRM records; it exposes no delete tool or arbitrary Firestore access.

The authorization server supports RFC 9207 issuer identification and the stable official ChatGPT callback. If the host explicitly supplies a per-connector callback instead, use only that exact observed URL in the CHATGPT_REDIRECT_URIS function environment variable. This setting is optional; never use a wildcard or guess a callback ID. Comma-separated configured URLs must be exact https://chatgpt.com/connector/oauth/<id> callbacks.

Legacy Claude tokens retain their existing task-only access until the user explicitly reconnects with broader scopes. Existing task logging and Gmail message deduplication remain supported.

## Verify live behavior

1. Read tools/list through the host-supported authenticated MCP client. New tools: searchCrmRecords, getCrmRecord, saveCrmRecord. A legacy Claude token should still see only logCrmTask.
2. Search a supported board; check live IDs against the CRM.
3. With an explicit real recording request, save and read back one life-admin item. Do not create arbitrary test clutter in production.
4. Read the full Roman's Pizza correspondence, find existing HubSpot/CRM records, and track the established opportunity once authorized. Store cross-system IDs and verify HubSpot deal, CRM deal and Brand Deals content row.
5. If one destination fails, persist a SYNC_PENDING marker on the successful destination and reconcile only the missing writes. Do not create a second HubSpot deal.

## Background monitoring

The plugin is invoked in chat; it does not continuously monitor Gmail. Only activate a separate host automation after a successful harmless read on Gmail, HubSpot and the live CRM.

Inspect the user's existing email monitor before creating a second one. Preserve its notifications and scope. The brand workflow logs new client/brand messages once, associates them with the correct campaign, updates confirmed terms, and alerts on meaningful changes or actions required. It never sends messages or accepts deals.

The initial scope is relevant brand/client correspondence, not every unrelated personal email. A broader archival request needs separately defined scope.

## Current verification boundary

Local connector, OAuth, deduplication, sparse-update and legacy compatibility tests are implemented. They use in-memory Firebase doubles and are not a live Firebase integration test. Live deployment, OAuth linking, one real deal across both systems and background automation activation must be verified separately. Source and skill package creation alone do not make the CRM tools available in future chats.
