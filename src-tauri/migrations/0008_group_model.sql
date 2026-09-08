-- A column can pin its own model: review with one, commit with a cheaper one.
-- Null means "whatever the chosen agent runs".
ALTER TABLE board_groups ADD COLUMN model TEXT;
