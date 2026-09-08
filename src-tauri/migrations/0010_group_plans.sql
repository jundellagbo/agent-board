-- Whether cards in this column get a plan before any work starts.
ALTER TABLE board_groups ADD COLUMN plans INTEGER NOT NULL DEFAULT 0;

-- The queue column is where planning belongs, on boards new and old.
UPDATE board_groups SET plans = 1 WHERE board_type = 'todo';
