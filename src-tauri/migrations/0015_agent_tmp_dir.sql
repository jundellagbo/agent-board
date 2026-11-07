-- Let the seeded Claude agents into the card's scratch store, which lives
-- outside the worktree they run in. Matching the exact previous command means an
-- agent someone has edited keeps what they wrote, and the flag is visible in the
-- agent editor rather than applied behind their back.
UPDATE agents SET command = 'claude --permission-mode auto --model {model} --add-dir {tmp} {prompt}'
 WHERE command = 'claude --permission-mode auto --model {model} {prompt}';

UPDATE agents SET command = 'claude -p --permission-mode auto --model {model} --add-dir {tmp} {prompt}'
 WHERE command = 'claude -p --permission-mode auto --model {model} {prompt}';
