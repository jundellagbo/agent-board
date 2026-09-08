-- What a run left behind, so the next column's agent can be told what the
-- previous one already did instead of starting from nothing.
ALTER TABLE task_runs ADD COLUMN summary TEXT;
