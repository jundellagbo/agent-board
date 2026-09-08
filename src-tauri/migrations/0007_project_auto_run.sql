-- Auto-mode is the point of the app, so it is on unless a project turns it off.
-- A column still has to opt in with its own auto_run; this is the master switch.
ALTER TABLE projects ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 1;
