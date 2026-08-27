# ALLY CRM

Personal life-management dashboard: content pipeline, song roadmap, life unlocks, apartment furnishing, brand deals, and the Mama work HQ.

Single-page React app with no build step. Markup, styles and the entire app live in `index.html`, and JSX is compiled in the browser by Babel standalone. There is no `package.json`, no `node_modules` and no `src/` directory.

## Structure

`index.html` is the whole app (~3,800 lines) — every React component sits inside a single `<script type="text/babel">` block, and this is the file you edit. `index-CHATGPT.html` is a separate standalone variant kept in the repo and is not the live entry point. `manifest.json`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png` and `icon-512.png` are PWA / homescreen assets. `robots.txt` plus a `noindex` meta tag keep the deployed site out of search results. `.github/workflows/deploy.yml` handles deployment.

Everything else loads from CDNs at runtime: React 18 and ReactDOM 18 (unpkg), Babel standalone, Tailwind CSS (cdn.tailwindcss.com), and the Firebase compat SDKs for app, auth and firestore (gstatic).

## Run locally

Nothing to install and nothing to build — just serve the folder over HTTP:

```bash
python3 -m http.server 5000
# then open http://localhost:5000
```

**Use port 5000, not 8000.** Google treats every port as a separate origin, and the OAuth client only authorises `http://localhost` and `http://localhost:5000`. Serving on 8000 will fail the moment anything touches Google sign-in or the Calendar API, with an `origin_mismatch` error rather than anything helpful.

Use a local server rather than opening `index.html` over `file://`, because Firebase Auth needs an http(s) origin. To sign in from localhost, `localhost` must be listed under Firebase Auth authorised domains and as an authorised JavaScript origin on the Google OAuth client.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which uploads the repo root as-is and publishes it to GitHub Pages. There is no build command and no publish directory — the repo root is the site.

## Data and auth

Google sign-in through Firebase Auth gates access to the app. Every authorised user shares the live Firestore document at `workspaces/ally-crm`; `onSnapshot` updates open sessions immediately and transaction-based three-way merging prevents stale browsers from overwriting unrelated changes or resurrecting deleted tasks. `localStorage` remains an offline cache and emergency backup, not the primary backend.

Firestore access is defined in `firestore.rules`. The original owner is recognised by the legacy `users/<uid>` document and `ally@mama.co.za` is an explicit collaborator. Deploy rule changes with `firebase deploy --only firestore:rules` before deploying app code that depends on a new access policy.

The Google Sheet integration is a separate Content skit registry. It mirrors skit rows for workflow/reporting and is not the CRM database.

## Working on it

Branch off `main`, commit, and open a pull request. Because the app is one very large file, prefer small targeted edits — reformatting or whitespace churn makes diffs unreadable.
