-- Remote control is opt-in from here on: it hands a session to a phone, which
-- is not something a card should do because nobody said otherwise.
UPDATE tasks SET remote = 0;

-- Let the seeded Claude agents run without stopping to ask. Matching the exact
-- previous command means an agent someone has edited keeps what they wrote, and
-- the flag is visible in the agent editor rather than applied behind their back.
UPDATE agents SET command = 'claude --permission-mode auto --model {model} {prompt}'
 WHERE command = 'claude --model {model} {prompt}';

UPDATE agents SET command = 'claude -p --permission-mode auto --model {model} {prompt}'
 WHERE command = 'claude -p --model {model} {prompt}';
