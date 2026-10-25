-- Paired AI agents, one row per credential the wallet has issued.
--
-- The credential itself is a JWT and is NOT stored: the row exists so a pairing can be *listed* and
-- *revoked*, which a signed token cannot express on its own. Verification is signature + row present +
-- not revoked, so revoking is a single UPDATE and takes effect on the agent's next call.
--
-- `subject` is the identity's `pnyx_id`, matching every other row in this database, and is what the
-- relay routes on — one socket per device serves all of that identity's agents.
CREATE TABLE IF NOT EXISTS mcp_pairings (
  pairing_id TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  -- What the user typed to recognise it later ("Claude Code on the laptop"). Shown in the pairing list.
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Null while live. Set, never deleted: a revoked pairing stays visible so a user can see that it was
  -- revoked rather than wondering whether it ever existed.
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS mcp_pairings_by_subject ON mcp_pairings (subject, created_at DESC);
