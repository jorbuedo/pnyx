-- Who claimed a key package (docs/ABUSE_MITIGATION.md §5, defect D3).
--
-- A claim was anonymous: the row recorded that a package had been spent, never by whom. So a
-- stranger could take every package a subject had published — verified, 3 of 3 — and until that
-- device refilled, every legitimate peer trying to start a conversation got a 409. A denial of
-- service on being reachable at all, and invisible afterwards because nothing recorded the taker.
--
-- ⚠️ **This column bounds a drain; it is not consent.** Anyone may still claim. Identity is free
-- (§0), so the same drain spread across fresh subjects still works — the fix for that is the
-- consent layer, not a lower cap. What the column buys is a per-(claimer, target) rate bound now,
-- and the attribution the consent layer will need anyway.
ALTER TABLE dm_key_packages ADD COLUMN claimed_by TEXT;

-- The cap query: how many this claimer has taken from this pool lately.
CREATE INDEX dm_key_packages_claimed_by ON dm_key_packages (subject, claimed_by, claimed_at);
