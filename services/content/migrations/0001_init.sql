-- D1 schema for the Pnyx content store (ContentStore port, services/content/src/store.ts).
-- Invariants enforced at the DB level, so no new call site can bypass them:
--   vote-once            → PRIMARY KEY (proposal_id, subject) on votes
--   persona-unique/circle → UNIQUE INDEX (circle_id, persona COLLATE NOCASE) on memberships
-- Derived at read time (never stored, never drifts):
--   circle.memberCount   → COUNT(memberships) per circle
--   proposal.tally       → COUNT(votes) grouped by value per proposal
-- ChainRef is flattened onto each entity that carries one (nullable columns);
-- chain_seq_id is ChainRef.chainId (sequential on-chain counter), distinct from row id.

CREATE TABLE circles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  author       TEXT NOT NULL,          -- creator persona label (never the subject)
  created_at   TEXT NOT NULL,          -- ISO-8601
  chain_status TEXT,                   -- 'pending' | 'confirmed' | 'failed'
  chain_tx_id  TEXT,
  chain_seq_id TEXT,
  chain_error  TEXT
);
CREATE INDEX idx_circles_created ON circles (created_at DESC);

CREATE TABLE memberships (
  circle_id    TEXT NOT NULL REFERENCES circles (id),
  subject      TEXT NOT NULL,
  persona      TEXT NOT NULL,
  disclosed    INTEGER NOT NULL,       -- 0/1
  joined_at    TEXT NOT NULL,
  chain_status TEXT,
  chain_tx_id  TEXT,
  chain_seq_id TEXT,
  chain_error  TEXT,
  PRIMARY KEY (circle_id, subject)      -- one membership per subject per circle → 'already-joined'
);
-- persona unique per circle, case-insensitive → 'persona-taken'
CREATE UNIQUE INDEX idx_memberships_persona ON memberships (circle_id, persona COLLATE NOCASE);

CREATE TABLE proposals (
  id           TEXT PRIMARY KEY,
  circle_id    TEXT NOT NULL REFERENCES circles (id),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  author       TEXT NOT NULL,          -- persona
  created_at   TEXT NOT NULL,
  chain_status TEXT,
  chain_tx_id  TEXT,
  chain_seq_id TEXT,
  chain_error  TEXT
);
CREATE INDEX idx_proposals_circle ON proposals (circle_id, created_at DESC);

CREATE TABLE votes (
  proposal_id  TEXT NOT NULL REFERENCES proposals (id),
  subject      TEXT NOT NULL,
  value        TEXT NOT NULL CHECK (value IN ('yes', 'no')),
  created_at   TEXT NOT NULL,
  chain_status TEXT,
  chain_tx_id  TEXT,
  chain_seq_id TEXT,
  chain_error  TEXT,
  PRIMARY KEY (proposal_id, subject)    -- vote-once (mirrors the action-nullifier rule)
);
CREATE INDEX idx_votes_proposal ON votes (proposal_id);

CREATE TABLE posts (
  id           TEXT PRIMARY KEY,
  circle_id    TEXT NOT NULL REFERENCES circles (id),
  parent_id    TEXT,                    -- nullable; a reply references a post in the same circle
  body         TEXT NOT NULL,
  author       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_posts_circle ON posts (circle_id, created_at ASC);

CREATE TABLE devices (
  fcm_token    TEXT PRIMARY KEY,        -- upsert by token (a token belongs to one subject)
  subject      TEXT NOT NULL,
  platform     TEXT NOT NULL,
  registered_at TEXT NOT NULL
);
CREATE INDEX idx_devices_subject ON devices (subject);
