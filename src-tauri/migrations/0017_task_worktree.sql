-- Whether the card gets a checkout of its own. On unless someone turns it off:
-- parallel agents sharing one working tree overwrite each other's edits, and the
-- card that opts out is the exception, not the rule.
ALTER TABLE tasks ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 1;
