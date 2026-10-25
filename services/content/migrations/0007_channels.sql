-- Channels: a grouping label for a circle's posts, content-layer only.
--
-- ⚠️ **Not a contract, and never will be** (decided 2026-08-25, `docs/BOUNDED_STATE_ARCHITECTURE.md`
-- §10). A channel adds no new trust root: every post it groups is already in the content store, and
-- the circle's on-chain `moderators` tree is what gates who may create one. A channel with its own
-- membership would be a contract, and is deliberately not a launch requirement.

CREATE TABLE channels (
  id           TEXT PRIMARY KEY,
  circle_id    TEXT NOT NULL REFERENCES circles (id),
  name         TEXT NOT NULL,
  -- Persona label of the creator, never the subject — the same rule every authored row here follows.
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- One `#general` per circle, not one per creator racing another. The uniqueness is what makes a
-- channel referable by name.
CREATE UNIQUE INDEX idx_channels_circle_name ON channels (circle_id, name);
CREATE INDEX idx_channels_circle ON channels (circle_id, created_at ASC);

-- ⚠️ **Nullable, and NULL is not "unknown"** — it means the circle's default stream, which is what
-- every post written before channels existed belongs to. Backfilling them into a synthesised
-- `#general` row would invent a channel nobody created and change what those posts say they are.
ALTER TABLE posts ADD COLUMN channel_id TEXT;
CREATE INDEX idx_posts_channel ON posts (circle_id, channel_id, created_at ASC);
