-- The DM consent layer (docs/ABUSE_MITIGATION.md §5): who may reach you, and whether it buzzes.
--
-- Three settings, three shapes, and the shapes are the design. What is NOT here matters as much as
-- what is: there is **no permits table**. A permit is a stateless signed token, so issuing one
-- writes nothing — which is what stops this layer becoming a durable record of who may talk to whom,
-- the graph this service deliberately does not accumulate.

-- Per-subject preference. No peer in it, so this is not graph data at all.
-- Absent means `open`, which is today's behaviour: an identity that has never chosen is reachable.
CREATE TABLE dm_policy (
  subject    TEXT PRIMARY KEY,
  policy     TEXT NOT NULL,   -- 'open' | 'permit' | 'closed'
  updated_at TEXT NOT NULL
);

-- Revoked permits, which is how **mute** is expressed.
--
-- ⚠️ Opaque ids only. `jti` is random and is never derived from the pair, so a dump of this table
-- names nobody: it says some permit was revoked, not that Alice muted Bob. The recipient's device
-- learns the id because the sender presents the permit on every delivery and the service surfaces it
-- on the row the recipient reads.
--
-- ⚠️ `revoked_at` is a cutoff, not a flag. A permit is silenced only if it was issued at or before
-- this instant, so re-issuing after a mute (**unmute**) produces a token this row does not cover —
-- without needing a second table to say the revocation was itself cancelled.
CREATE TABLE dm_permit_revocations (
  jti        TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL,   -- ISO-8601; permits issued after this are unaffected
  expires_at TEXT NOT NULL    -- the revoked permit's own expiry; the row is dead weight after it
);
-- The sweep: revocations whose permit has expired can never matter again.
CREATE INDEX dm_permit_revocations_expiry ON dm_permit_revocations (expires_at);

-- Blocked senders: delivery refused outright, and no future permit works either.
--
-- ⚠️ **A plaintext pair, deliberately, and the only one here.** Block is the one setting that cannot
-- be a capability: mute only has to stop a token that exists, but block has to stop *re-acquisition*,
-- and "this specific peer may never get another permit" is irreducibly a statement about the pair.
-- It is also the one row a user would be upset to see expire, so unlike a mute it has no TTL.
CREATE TABLE dm_blocks (
  subject    TEXT NOT NULL,   -- who is doing the blocking
  peer       TEXT NOT NULL,   -- who is blocked
  created_at TEXT NOT NULL,
  PRIMARY KEY (subject, peer)
);

-- The permit a delivery was made under, so the *recipient* can learn its id.
--
-- ⚠️ This is the piece that makes mute work without storing a pair anywhere: the sender presents the
-- permit on every delivery, the id rides along on the row, and the recipient's device keeps it with
-- the conversation. Muting then names an opaque id rather than a person. The alternative — deriving
-- the id from the pair — would have needed a long-lived secret whose rotation silently un-mutes
-- everyone, which is a worse failure than the column.
--
-- No new knowledge: both rows already carry `sender` and `recipient`, so the pair is already here,
-- and both are deleted on ack.
ALTER TABLE dm_messages ADD COLUMN permit_jti TEXT;
ALTER TABLE dm_welcomes ADD COLUMN permit_jti TEXT;
