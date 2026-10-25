-- The character a circle shows on the rail, chosen by its founder.
--
-- The rail rendered `name.slice(0, 1).toUpperCase()`, so two circles whose names start with the same
-- letter were indistinguishable — which is exactly what happened with two "S" circles side by side.
-- One grapheme, so an emoji counts (including the multi-codepoint ones: skin tones and ZWJ sequences
-- are one grapheme and must not be split).
--
-- Nullable, and NULL means the founder has not chosen one — the rail falls back to the initial, which
-- is what every circle has always shown. That is a real answer, not a missing one.
ALTER TABLE circles ADD COLUMN display_char TEXT;
