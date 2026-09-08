-- Which model an agent runs. Kept separate from the command template so the
-- model can be chosen per card without rewriting the command.
ALTER TABLE agents ADD COLUMN model TEXT;
