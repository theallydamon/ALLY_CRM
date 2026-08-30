# Claude inbox connector

The deployed `crmConnector` Firebase function is a remote MCP server with one write-only tool: `logCrmTask`.

Deployment requires the Firebase project to use the Blaze plan because second-generation Cloud Functions depend on billed Google Cloud APIs. Set a small Google Cloud budget alert before deployment; budget alerts notify but do not hard-cap spend.

## Security boundaries

- Claude authenticates with OAuth and never receives a Firebase service-account key.
- The authorization screen accepts only `theallydamon@gmail.com` and `ally@mama.co.za`.
- The function writes with its managed Google service identity through the Firebase Admin SDK.
- The MCP surface exposes no read, update, delete, search, or arbitrary Firestore operation.
- `sourceMessageId` is hashed into an idempotency record, so retries do not create duplicates.
- Personal tasks are inserted into `ally.lifeAdmin.items`; work tasks are inserted into `mama.tasks`.

## Claude setup

Add the deployed function's `/mcp` URL under Claude **Settings → Connectors → Add custom connector**, then complete Google sign-in. Enable `logCrmTask` for the scheduled inbox task.

The scheduled-task instruction should require Claude to:

1. Log only genuine, still-open actions addressed to Ally.
2. Use `work` only for MAMA business and `personal` for everything else.
3. Pass Gmail's stable message ID as `sourceMessageId`.
4. Use a due date only when the message states a real deadline.
5. Skip FYIs, newsletters, receipts, marketing, calendar notices, and already-completed actions.
