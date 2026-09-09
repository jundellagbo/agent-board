-- The agent's plan, kept apart from the card's own text: a plan used to be
-- written over whatever the person had typed into the card, which is the one
-- thing on a card that is theirs.
ALTER TABLE tasks ADD COLUMN plan TEXT;
