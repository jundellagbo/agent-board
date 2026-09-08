-- Bring already-seeded agents onto the {model} placeholder. Matching the exact
-- original command means an agent the user has edited is left alone.
UPDATE agents SET model = 'claude-opus-5', command = 'claude --model {model} {prompt}'
 WHERE command = 'claude {prompt}';

UPDATE agents SET model = 'claude-opus-5', command = 'claude -p --model {model} {prompt}'
 WHERE command = 'claude -p {prompt}';

UPDATE agents SET command = 'aider --model {model} --message {prompt}'
 WHERE command = 'aider --message {prompt}';
