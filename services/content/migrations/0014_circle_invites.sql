-- Self-service invites: what a circle demands, and the codes it has to hand out.
--
-- A Compact circuit cannot read Cardano's ledger, so every predicate worth gating on needs an
-- off-chain attestor and the attestor's *output is an invite* (`docs/BOUNDED_STATE_ARCHITECTURE.md`
-- §"Gating a circle is an **invite**"). These two tables are that attestor's whole state.
--
-- ⚠️ **The service cannot mint an invite.** `setInvite` is moderator-gated and proving stays on
-- device, so a founder pre-mints a pool on their phone and uploads it here; this dispenses from
-- that pool and never touches the chain. The consequence to be honest about is that the service
-- holds usable secrets — that is exactly the gatekeeping authority the founder delegated, bounded
-- by how many they minted and revocable with `setInvite(commitment, false)`.

-- One policy per circle. Absent = no self-service path, which is the default and not a failure:
-- a gated circle whose founder hands out codes personally is a normal circle.
CREATE TABLE circle_invite_policies (
  circle_id  TEXT PRIMARY KEY REFERENCES circles (id),
  -- 'drep-any' | 'drep-delegated' | 'pool-member' | 'ada-threshold'. Parsed by
  -- `parseInvitePredicate`, which is where the set is actually defined.
  kind       TEXT NOT NULL,
  -- The drep id, pool id, or lovelace threshold as a decimal string. NULL for 'drep-any'.
  --
  -- ⚠️ A threshold is TEXT, never INTEGER: SQLite integers are 64-bit but the value crosses JSON,
  -- and a threshold someone later sets in the billions of ADA must not round through a double.
  param      TEXT,
  updated_at TEXT NOT NULL
);

-- The pool of pre-minted invites, and who has taken one.
CREATE TABLE circle_invites (
  circle_id    TEXT NOT NULL REFERENCES circles (id),
  -- Hex of `inviteCommitment(secret)` — the ledger key, and public by construction.
  commitment   TEXT NOT NULL,
  -- Hex of the 32-byte secret. **The capability.** Whoever reads this row can join the circle once.
  secret       TEXT NOT NULL,
  -- 'pending' until the device's `setInvite` settles. A pending invite is never dispensed: handing
  -- out a code whose commitment is not on chain yet produces a join that fails with "no such
  -- invite", which the recipient cannot act on and cannot distinguish from being refused.
  chain_status TEXT NOT NULL,
  -- The stake address that claimed it. NULL = available. Recorded rather than just decremented so
  -- a second request from the same wallet returns the same code instead of burning another.
  claimed_by   TEXT,
  claimed_at   TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (circle_id, commitment)
);

-- Dispensing is "the oldest confirmed unclaimed row", so the scan is an index seek.
CREATE INDEX idx_circle_invites_available
  ON circle_invites (circle_id, chain_status, claimed_by, created_at);

-- ⚠️ One invite per stake address per circle, enforced here rather than in the route.
--
-- The check-then-insert in a handler is two statements and Workers run many isolates: two
-- concurrent requests from the same wallet both read "no claim" and both take a code. A partial
-- unique index makes the second one lose, which is the only place that decision is safe to make.
CREATE UNIQUE INDEX idx_circle_invites_one_per_claimant
  ON circle_invites (circle_id, claimed_by) WHERE claimed_by IS NOT NULL;
