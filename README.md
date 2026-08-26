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

Google sign-in through Firebase Auth gates access to the app. Only `theallydamon@gmail.com` and `ally@mama.co.za` are admitted, and both sync the same CRM state through `workspaces/ally-crm` in Firestore. On the first primary-account login after this change, the app migrates the existing `users/<uid>` data into that shared workspace. The old user document is retained as a rollback copy.

Deploy `firestore.rules` to the `ally-crm-cbdd1` Firebase project before deploying this version of the app. Those rules are the security boundary that restricts the shared workspace to the two approved, verified Google accounts. The matching allowlist in `index.html` only provides a friendly sign-in error.

The `ALLY DAMON SKIT REGISTRY` Google Sheet is a separate shared mirror for skit items and their revision log; it is not the CRM database. The shared Firestore workspace is the live source of truth for the CRM. Each signed-in person authorises Sheets and Calendar access using their own Google account, so both accounts must retain access to that Sheet and any shared calendars they need.

State is also held in the browser via `localStorage`. The app runs as a Claude artifact unchanged: it detects `window.storage` and falls back to `localStorage` outside it.

## Working on it

Branch off `main`, commit, and open a pull request. Because the app is one very large file, prefer small targeted edits — reformatting or whitespace churn makes diffs unreadable.
