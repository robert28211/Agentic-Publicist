-- Agentic Publicist — D1 Schema
-- Run: npm run db:init (local) or npm run db:init:remote (production)

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- personal | agency | product
  bio_short TEXT,
  bio_long TEXT,
  expertise_keywords TEXT -- JSON array of strings
);

CREATE TABLE IF NOT EXISTS journalists (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  publication TEXT,
  beat_keywords TEXT, -- JSON array of strings
  last_contacted_at INTEGER, -- Unix ms; updated at send time (not approval)
  response_rate REAL DEFAULT 0,
  outlet_type TEXT DEFAULT 'journalist', -- journalist | blog | podcast
  contact_url TEXT -- pitch/contact page when no email is published
);

CREATE TABLE IF NOT EXISTS rejected_outlets (
  id TEXT PRIMARY KEY,
  name TEXT,
  publication TEXT,
  email TEXT,
  reason TEXT, -- 'not a fit' | 'removed from roster' | custom
  created_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rejected_key ON rejected_outlets (lower(name), lower(coalesce(publication,'')));

CREATE TABLE IF NOT EXISTS discovery_runs (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  outlet_type TEXT DEFAULT 'podcast', -- journalist | blog | podcast
  market TEXT,
  status TEXT DEFAULT 'pending', -- pending | processing | complete | error
  results TEXT, -- JSON array of candidates (with added:bool per candidate)
  error TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  entity_id TEXT REFERENCES entities(id),
  body TEXT NOT NULL,
  angles TEXT, -- JSON array of {angle, beat, publication_type}
  status TEXT DEFAULT 'pending', -- pending | processing | complete | error
  progress_log TEXT DEFAULT '[]', -- JSON [{step, done, ts}]
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS pitches (
  id TEXT PRIMARY KEY,
  entity_id TEXT REFERENCES entities(id),
  journalist_id TEXT REFERENCES journalists(id),
  brief_id TEXT REFERENCES briefs(id),
  story_angle TEXT,
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'pending', -- pending | approved | skipped | sent | bounced
  resend_email_id TEXT, -- set at send time; matched by bounce webhook
  created_at INTEGER,
  approved_at INTEGER,
  sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS coverage (
  id TEXT PRIMARY KEY,
  entity_id TEXT REFERENCES entities(id),
  url TEXT NOT NULL,
  headline TEXT,
  publication TEXT,
  published_at INTEGER,
  sentiment TEXT, -- positive | neutral | negative
  hash TEXT UNIQUE, -- SHA-256 of normalized URL (no query params)
  created_at INTEGER
);
