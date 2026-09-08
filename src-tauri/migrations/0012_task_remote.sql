-- Whether the card's session is opened up for remote control, so the agent can
-- be driven from a phone. On unless someone turns it off.
ALTER TABLE tasks ADD COLUMN remote INTEGER NOT NULL DEFAULT 1;
