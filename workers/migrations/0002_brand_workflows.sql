-- Durable queue and outbox are separate from browser-saved CRM records.
CREATE TABLE IF NOT EXISTS brand_candidates (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'review',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS brand_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated INTEGER NOT NULL
);
