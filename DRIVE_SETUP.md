# Lasting task attachment connection

The browser uses Google's authorization-code popup once. The existing Cloudflare
Worker exchanges the code and stores the refresh credential encrypted with
`CONNECTION_KEY` in its existing D1 database. On each CRM sign-in it restores an
access token using the Firebase identity. Expired access tokens renew before an
upload. No refresh credential or Google client secret goes to browser storage,
the workspace document, source control or logs.

Only the existing approved CRM accounts and the exact origin
`https://www.theallydamon.com` can use these routes. Calendar and Sheets use their
existing connection. File uploads remain direct from the browser to Drive.

## Required configuration before release

1. In Google Cloud project `ally-crm-cbdd1`, use the existing web OAuth client
   `139362174943-bg2h6vu4tgt6is8tu0ca415nea741fn3.apps.googleusercontent.com`.
   The account owner must add an additional client secret. Preserve the existing
   Firebase-managed secret and all authorized origins and redirects.
2. Save the new value only as encrypted Worker secret `DRIVE_CLIENT_SECRET` on
   `ally-crm-connector`. Do not paste it into chat, a PR, source or command arguments.
   Preserve `CONNECTION_KEY` and `FIREBASE_SERVER_API_KEY`.
3. Complete the OAuth app's required branding configuration and move its audience
   from Testing to Production. Google expires refresh grants after seven days in
   Testing when Drive scope is requested. Backend CRM access remains restricted
   to the existing approved accounts.
4. Deploy the Worker first using its existing D1 binding. No schema change or new
   database is required. Then release the frontend through GitHub Pages.
5. The owner connects Drive once using the new flow. Verify reopening the CRM
   restores `Attach file` without a popup, and an expired access token renews.

Google may still require reconnection if the owner revokes access, changes
account security, or Google's refresh-token policies invalidate the grant. The
application imposes no recurring consent interval. `POST /drive/disconnect`
deletes the stored credential without revoking unrelated Google permissions.

References: [Google code flow](https://developers.google.com/identity/oauth2/web/guides/use-code-model)
and [refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

## Verification

Run `node --test tests/task-files.test.cjs workers/drive.test.mjs workers/worker.test.mjs`.
The tests use mocked Google services and local SQLite. They cover reopening,
automatic renewal, account changes, denied grants, expiry, encrypted storage,
revocation, temporary failures, origin restrictions and existing CRM behavior.
They do not establish a live Google connection.
