-- Direct messages: the delivery layer for MLS (docs/DIRECT_MESSAGES_PLAN.md phase 4).
--
-- This service stores CIPHERTEXT ONLY and is deliberately NOT the source of truth for anything
-- security-relevant. Identity anchors live on chain (`dmKeybook` in pnyx.compact); the server
-- never sees a private key, a group secret, or a plaintext.
--
-- It is also one implementation of a swappable port, not the design. Conversation ids are derived
-- by the clients (sha256 over the sorted pnyx_id pair) and message ordering is by the sender's
-- MLS epoch/generation rather than by anything the server assigns, so a different transport can
-- serve the same conversations without renumbering them. Nothing here may become load-bearing:
-- no server-assigned ids, no server-authoritative ordering.

-- Consumable MLS KeyPackages, the "prekey pool". One row is one single-use package: MLS's init key
-- is not meant to be reused across joins, so `claimed_at` marks a package spent rather than
-- deleting it (a claim and a re-fetch must not silently hand out the same package twice).
CREATE TABLE dm_key_packages (
  id         TEXT PRIMARY KEY,      -- sha256 of the package bytes; dedupes re-uploads
  subject    TEXT NOT NULL,         -- pnyx_id of the owner
  package    BLOB NOT NULL,         -- serialised MLS KeyPackage
  created_at TEXT NOT NULL,         -- ISO-8601, matching 0001_init
  claimed_at TEXT                   -- ISO-8601; NULL means available
);
-- The claim query: **newest** unclaimed package for a subject (changed 2026-09-01). FIFO was the
-- prekey convention, but a reinstalled device leaves its old public halves published with the private
-- ones gone, so the oldest unclaimed rows are precisely the orphans — and handing one out produces a
-- Welcome the joiner can never open. Order does not affect single-use safety; the conditional UPDATE
-- in claimDmKeyPackage does. The index serves either direction. See src/dm-retention.ts.
CREATE INDEX dm_key_packages_available ON dm_key_packages (subject, claimed_at, created_at);

-- Ciphertext messages. `conv_id` is client-derived, so a row can be written before the server has
-- ever heard of the conversation — there is no conversations table to keep in step.
CREATE TABLE dm_messages (
  id          TEXT PRIMARY KEY,     -- client-generated ulid-ish; server never mints ids
  conv_id     TEXT NOT NULL,
  sender      TEXT NOT NULL,        -- pnyx_id; a claim, authenticated by MLS not by this column
  recipient   TEXT NOT NULL,        -- pnyx_id; used only for inbox fan-out
  ciphertext  BLOB NOT NULL,        -- serialised MLS PrivateMessage
  created_at  TEXT NOT NULL         -- ISO-8601 server receipt time (delivery metadata only)
);
-- The polling query: everything in a conversation after a cursor.
CREATE INDEX dm_messages_conv ON dm_messages (conv_id, created_at);
-- The inbox query: conversations involving a subject, newest first.
CREATE INDEX dm_messages_recipient ON dm_messages (recipient, created_at DESC);
CREATE INDEX dm_messages_sender ON dm_messages (sender, created_at DESC);

-- NOTE: the `mn_addr` in these comments was corrected to `pnyx_id` on 2026-08-05. Only comments
-- changed; the identity migration replaced `mn_addr` with `C` as the subject and the columns always
-- held whatever the JWT subject was (`sender: subject` in routes.ts).

-- MLS Welcome + ratchet tree for a pending invite. Separate from dm_messages because a Welcome is
-- addressed to a member who is not yet in the group and so cannot be an application message.
-- Deleted once fetched: a Welcome is single-use, and retaining it after the join would leave group
-- entry material sitting on the server for no reason.
CREATE TABLE dm_welcomes (
  id           TEXT PRIMARY KEY,
  conv_id      TEXT NOT NULL,
  recipient    TEXT NOT NULL,       -- pnyx_id the Welcome is for
  sender       TEXT NOT NULL,
  welcome      BLOB NOT NULL,       -- serialised MLS Welcome message
  ratchet_tree BLOB NOT NULL,       -- serialised RatchetTree the joiner needs
  created_at   TEXT NOT NULL
);
CREATE INDEX dm_welcomes_recipient ON dm_welcomes (recipient, created_at);
