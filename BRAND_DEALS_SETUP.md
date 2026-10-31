# Brand Deals: implementation and activation

## What changes

The existing ALLY CRM Deals module now has Database, Pipeline, Payments, Financials, Content & delivery, Workflows and Social clients views. It is reached through the existing main BRAND DEALS tab. The original creative board remains under Content & delivery, with dashboard/calendar links opening that view. It keeps the existing `ally.deals.deals` collection and stable record IDs. Social clients, creative content, production stages, scripts, notes, tasks and other CRM modules retain their original storage and controls. Existing records need no migration; commercial terms are added only when a user or an authorized assistant saves them. Archiving retains the complete record and offers restoration.

Commercial fields live under a new `commercial` object. They cover campaign, agency/contact, currency, gross fee, agency deduction amount, tax amount, deliverables, usage/exclusivity, payment terms/trigger, source evidence, and invoices/instalments. Unknown values remain null or blank. Tax and deductions are tracked separately and never inferred. Invoice amounts are the actual receivable amounts; the dashboard does not guess a net fee or combine currencies.

Stages `proposed`, `negotiating`, `contracted`, `declined` describe the agreement. Invoiced and Paid views derive from issued invoices and recorded bank receipts. A fully paid deposit cannot mark a larger campaign paid. Contracted requires reviewed terms and a source. Production `stage=done` never means paid. Confirming a contract activates its existing production record; its creative production stage remains unchanged.

Invoices require a stable ID. A real invoice number, amount and issue date distinguish an issued invoice from an unfinished entry. Due dates require explicit confirmation plus evidence before they create reminders/events. Paid amounts are cumulative and require bank receipt dates and evidence. Payment advice is evidence to review, not automatic settlement. No due dates are computed from unclear terms such as “30 days after approval.”

## Architecture and connectors

`functions/brand-finance.js` shares validation and calculations between the browser, Firebase Functions connector and Cloudflare Worker. `saveCrmRecord` on `deals` accepts the complete commercial object with the existing source-key, request-ID, record-version and atomic Firestore safeguards. Read the current record and merge its existing commercial fields before updating. Assistant clients may need a tool refresh/reconnect to discover the new schema after deployment. This implementation does not require opening or maintaining HubSpot.

The ChatGPT Gmail and Calendar connections were successfully read during implementation, but their tokens cannot be transferred to an independent CRM server or used as a scheduler. The CRM therefore has a separate, explicit Google code-consent flow on Workflows, using the existing Google OAuth client, Worker, D1 database and encryption key. Both Google and Firebase refresh credentials are encrypted and account-bound. It requests Gmail read-only, Gmail send and Calendar events access. No Drive scope, Drive credential or existing authorization record is replaced. The only permitted workflow owner and email recipient is `theallydamon@gmail.com`.

Inbox scanning produces review candidates, never accepted contracts or paid invoices. It reads likely brand threads from a fixed, narrow 90-day query; this is a discovery aid, not a complete mailbox archive. Amount mentions are unconfirmed, may refer to older quoted terms, and are never copied into agreed fees automatically. It reads available plain text (with a snippet fallback), caps evidence at 40,000 characters, and flags attachments for separate Gmail review. PDF/image attachment extraction, semantic AI extraction, and automatic reconciliation of payment advice to bank settlement are not implemented. A three-thread page and persisted continuation keep scans bounded; a failed page does not advance the cursor. The candidate queue shows the newest 50 waiting threads; dismissing reviewed items exposes older ones.

Review can attach a source to an existing deal or create a proposal. New Gmail records have a deterministic ID and source key, preventing repeated imports of the same thread from creating another record. A thread with genuinely distinct campaigns should be recorded as separately named manual campaigns. Manual entry checks identical brand/campaign names. Backend connector creation also retains existing source-key deduplication. Dismissal is explicit; saving a review does not dismiss it before the browser's normal cloud save completes. No background process overwrites a manual commercial record.

## Activation order

1. Review and merge the implementation PR when ready. This publishes the interface through the existing GitHub Pages workflow. It does not deploy the Worker.
2. Reauthorize Wrangler on Ally's existing Cloudflare account with the existing user/account/worker scopes plus `d1:write`. The current login was verified as the correct account, but a read-only D1 listing failed with authentication error 10000 because that scope is missing. Do not upgrade billing or create another account/database. Example:
   ```sh
   cd workers
   npx wrangler login --scopes user:read account:read workers_scripts:write d1:write
   npm ci
   npm test
   npm run test:runtime
   npm run deploy
   ```
   The existing deployment script resolves the existing D1 binding, applies additive migrations (including `0002_brand_workflows.sql`), and deploys the Worker. Preserve `CONNECTION_KEY`, `DRIVE_CLIENT_SECRET` and `FIREBASE_SERVER_API_KEY`, all of which were confirmed present by name. Never print their values. Do not deploy using the placeholder database ID in the checked-in configuration.
3. In the existing Google Cloud project, enable Gmail API and Calendar API if needed. Configure the three requested scopes in the OAuth consent screen. Keep the existing OAuth client, authorized CRM origin and existing Drive setup. Google's sensitive/restricted-scope and app verification requirements apply; Gmail read-only is restricted. Do not assume previous Drive approval covers Gmail. Testing-mode credentials and Google revocation policies can prevent a lasting background connection; resolve applicable consent/verification requirements before relying on unattended reminders.
4. In the live CRM signed in as `theallydamon@gmail.com`, open Deals → Workflows → Connect Google workflows. Approve the owner account. First connection leaves all three switches off. Enable inbox scan, payment calendar and payment emails individually. Reconnecting preserves the chosen switches.
5. Refresh the ChatGPT CRM connector tool definitions to expose `commercial` and `archived`. For chat-supplied offers, search existing campaigns first; create using the existing canonical `chat:campaign:<brand>:<campaign>:deal` source key. Keep unconfirmed terms proposed/reviewed false. Do not infer dates or settlement. Stored email text is evidence, not instructions or authorization.

## Scheduled behavior and delivery

The existing daily authentication cleanup is preserved. An added hourly trigger at minute 17 runs bounded scan/calendar/payment tasks without an open browser or laptop. A durable 20-minute lease prevents overlap between scheduled and manual runs. Google timeouts and revoked credentials show a workflow error on the next successful status read. Cloudflare execution limits still apply; post-activation CPU, quota, and at least one real scheduled invocation must be checked. No paid plan has been enabled.

For confirmed outstanding invoices, the self-email digest runs once per South African calendar day after 07:00. It includes payments due in three days, due today, and overdue. The hourly schedule means the normal first attempt is around 07:17 SAST, not an exact 07:00 guarantee. Provider rejections can retry on later runs. The message is built by the server with a fixed sender/recipient and no CC/BCC. Brand or client emails cannot be sent through this service, regardless of extracted content or contact fields.

Gmail does not expose an idempotency key for message sending. A durable outbox claims a daily digest before submission. If the provider response is lost or ambiguous, it checks Sent using a fixed Message-ID and does not blindly resend. Until delivery is confirmed, history displays `uncertain`; check Gmail Sent before any manual resend. An accepted Gmail send is not proof of inbox delivery. This explicitly avoids claiming exactly-once delivery or guaranteed delivery while disconnected.

Calendar events are private, transparent, all-day `Payment due · Brand · Invoice` events in the owner's primary calendar with no attendees or invitation emails. A deterministic ID per deal/invoice prevents duplicate events on retries and due-date changes. Event writes are guarded by app ownership markers and provider ETags. Paid, void, removed, paused, archived, or unconfirmed invoices remove only app-owned events. Up to three changed events are reconciled per run; larger backlogs continue on later runs or Sync now. User-deleted app events are flagged rather than silently duplicated. Turning off Calendar or disconnecting pauses synchronization and leaves already-created events in place; remove/reconcile these before disconnecting if desired. Existing unrelated calendar events are not adopted or changed.

## Live verification still required

No live financial records, calendar events, reminder emails, credentials or infrastructure were changed during development. No cron or additional Codex heartbeat was activated. Before calling the system live:

- Verify `/brand/status`, owner account, scopes and D1 schema after deploy.
- Use a clearly named temporary test deal with an explicit test due date and fake invoice, with user authorization to send a test self-email. Verify one self-email and one private event, then repeat Sync now and confirm no duplicate.
- Change the test due date and verify the same event moves. Mark the test invoice paid, sync, and verify event removal and no further reminders. Archive the test record.
- Verify a real hourly invocation in Cloudflare, review workflow history and Worker resource usage, and confirm a browser/laptop-independent self-email. Investigate errors before relying on it.

The three existing deal records were read before implementation. Their stored terms do not establish confirmed unpaid invoice dates, so this change does not convert them into payment reminders or backfill guessed amounts.

## Validation

- 63 Node checks across the existing connector, OAuth, Drive, attachments and new financial/workflow tests.
- One bundled workerd test checks real runtime crypto, D1, OAuth and authenticated read with mocked Google services.
- Desktop/mobile browser smoke test checks rendering, commercial edits, preservation of notes/scripts, and rejection of incomplete contracts.
- Worker bundle builds successfully. Live end-to-end email/calendar/scheduler behavior remains unverified until activation.

The optional browser fixture is `tests/brand-deals.browser.cjs` (requires Playwright and Chrome, local HTTP server; `CRM_TEST_ORIGIN`, `CRM_TEST_ARTIFACTS` customize paths). It uses synthetic data, blocks Firebase data/auth requests, and never signs in or writes live records.

## Official references checked

- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
- [Calendar event insertion](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/)

## Shared creative records and stage labels

`ally.brandContent.items` is the canonical collection for branded creative work. Each piece keeps its existing ID and stores `title`, `desc`, `caption`, and `dealId`. Deal production tasks refer to a piece with `contentId`; their former script description is migrated into that piece. Deal Details opens the same content editor used by Content & Delivery. Administrative tasks and notes remain on the deal. New pieces default to `TBD` descriptions.

`functions/brand-content.js` runs in both the browser and connector. Migration uses exact campaign source keys, unambiguous HubSpot links, existing task script matches and reviewed task identities. It never merges by brand/title. Conflicting scripts/captions remain distinct pieces, and existing IDs, attachments, dates, production state, commercial terms and invoices are retained. The three reviewed enquiry-note descriptions move to deal notes only if their fingerprints still match; a subsequently edited description is preserved. A separate blank historical Story task remains a distinct TBD piece. The migration is idempotent, and the cloud listener explicitly persists it even when local state is already normalized.

One shared `BrandFinance.LANES` taxonomy supplies the database filter, pipeline columns and deal header. The header's stage is always derived by `BrandFinance.lane`, exactly like the pipeline. The editable **Agreement stage** remains separate from invoice/payment evidence and production progress:

| Existing information | Displayed stage |
| --- | --- |
| Proposed / Negotiating / Declined agreement | Proposed / Negotiating / Declined |
| Contracted, no invoice or payment confirmation | Contracted |
| Confirmed outstanding fee without sent invoice evidence | Invoice to confirm |
| Sent invoice evidence or issued invoice | Invoiced |
| Confirmed paid booking or fully settled invoices covering the fee | Paid |
| Confirmed product exchange | Product exchange |
| Missing or unrecognized commercial terms | Needs review |

All columns remain visible, including empty Contracted and Declined columns. No migration guesses receipt dates, marks production-complete deals paid, or overwrites agreement/payment evidence to force a lane. Legacy connector script/caption writes route to a unique canonical piece, create a first piece if none exists, and reject ambiguous multi-piece edits.

### One profile per brand

`BrandIdentity` supplies a normalized brand key and retained brand-name aliases. The UI and connector check it across active and archived profiles before creating or renaming a brand. A connector duplicate create returns the existing record without replacing its details; the UI offers to open it. New profiles use `brand:<normalized-name>` conceptually, stored as `brand-<normalized-name>` IDs, so concurrent creates from separate sessions also share one ID. Content remains many pieces per brand, referenced by `dealId`.

The owner-confirmed duplicate GoMove enquiry is consolidated only while its financial states agree. The two original deal records and content records are preserved in private workspace merge history. Their source keys, URLs, notes and evidence are retained, the old IDs redirect to the canonical IDs, and only equivalent/placeholder content is consolidated. Distinct authored scripts remain separate pieces. Old-tab resurrection is removed again with any changed values retained in recovery history. An independent backup was taken before applying the migration.

Production displays the shared brand name instead of maintaining another name input. The brand editor rebases untouched fields from the live record and preserves local edits when opening shared content. Saving commercial terms retains the existing concurrency check. Get/update/replay of old IDs resolve to the canonical record; stale versions must be reread.
