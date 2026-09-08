-- A card can pin its own model. Null means "whatever the chosen agent runs".
ALTER TABLE tasks ADD COLUMN model TEXT;
