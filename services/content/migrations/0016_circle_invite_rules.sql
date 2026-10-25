-- A circle gates on a **set** of requirements, not one.
--
-- `0014` gave `circle_invite_policies` a single `(kind, param)`, which forced a founder to pick one
-- group and turn everyone else away. A circle usually wants several: people delegating to its DRep,
-- *or* people staking with its pool, *or* people holding enough ADA.
--
-- ⚠️ **Any-of, not all-of.** The founder's question is "who may join", and a list under that heading
-- is a list of groups who may. All-of would make two rules strictly narrower than one, so adding a
-- second rule to widen a circle would quietly close it. `accountSatisfiesAny` is where that lives.
CREATE TABLE circle_invite_rules (
  circle_id TEXT NOT NULL REFERENCES circles (id),
  -- 'drep-delegated' | 'pool-member' | 'ada-threshold'. Parsed by `parseInvitePredicate`, which is
  -- where the set is actually defined.
  kind      TEXT NOT NULL,
  -- The drep id, pool id, or lovelace threshold as a decimal string.
  --
  -- ⚠️ TEXT for a threshold, never INTEGER: SQLite integers are 64-bit but the value crosses JSON,
  -- and a threshold someone later sets in the billions of ADA must not round through a double.
  param     TEXT,
  -- One kind at most once per circle. Two `ada-threshold` rules is a founder who meant to edit one,
  -- and under any-of the lower would silently win — so the schema refuses it rather than resolving it.
  PRIMARY KEY (circle_id, kind)
);

-- Carry the existing single rule across. `drep-any` is deliberately NOT carried: "delegating to any
-- DRep at all" was withdrawn on 2026-09-10 as a rule nobody asked for, and there is no parser branch
-- left to read one back — a kind the UI cannot produce and the parser still accepts is a rule that
-- can only ever arrive by accident.
INSERT INTO circle_invite_rules (circle_id, kind, param)
  SELECT circle_id, kind, param FROM circle_invite_policies WHERE kind <> 'drep-any';

-- A policy row now records only that self-service is on, and which authority would issue for it. The
-- `kind`/`param` columns are left in place rather than dropped: SQLite rewrites the whole table for a
-- DROP COLUMN, the values are the backfill's own provenance, and nothing reads them after this.
--
-- ⚠️ A circle whose only rule was `drep-any` keeps its policy row and now has **no rules**, which the
-- routes treat as "no self-service" — the honest state, and one its founder fixes by choosing again.
