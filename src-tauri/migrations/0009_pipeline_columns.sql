-- Bring boards created before the pipeline existed onto it: rename In Review,
-- then add Agent Review and Commit between it and Completed.
--
-- Only boards that are still exactly the original four columns are touched. A
-- board someone has renamed, reordered or added to is theirs, not ours.
CREATE TEMP TABLE upgradable AS
SELECT project_id
  FROM board_groups
 GROUP BY project_id
HAVING count(*) = 4
   AND sum(name IN ('Todo', 'In Progress', 'In Review', 'Completed')) = 4;

UPDATE board_groups SET name = 'For Review'
 WHERE name = 'In Review' AND project_id IN (SELECT project_id FROM upgradable);

UPDATE board_groups SET position = 5
 WHERE name = 'Completed' AND project_id IN (SELECT project_id FROM upgradable);

INSERT INTO board_groups (id, project_id, name, board_type, position, auto_run, prompt)
SELECT lower(hex(randomblob(16))), project_id, 'Agent Review', 'custom', 3, 1,
       'Review the change on this branch. Read the diff, check it does what the card asked, '
       || 'and look for correctness bugs, missing edge cases and anything left half-done. Fix '
       || 'what is plainly wrong; leave judgement calls to a person and say what you left. Do '
       || 'not add features the card did not ask for.'
  FROM upgradable;

INSERT INTO board_groups (id, project_id, name, board_type, position, auto_run, prompt, model)
SELECT lower(hex(randomblob(16))), project_id, 'Commit', 'custom', 4, 1,
       'Commit the work already on this branch. Stage what changed, write one commit message '
       || 'saying what changed and why, and stop there. Do not edit code, do not add files the '
       || 'work did not touch, and do not push.',
       'claude-haiku-4-5'
  FROM upgradable;

UPDATE board_groups
   SET success_group_id = (SELECT id FROM board_groups target
                            WHERE target.project_id = board_groups.project_id
                              AND target.name = 'For Review')
 WHERE name = 'Todo' AND project_id IN (SELECT project_id FROM upgradable);

UPDATE board_groups
   SET success_group_id = (SELECT id FROM board_groups target
                            WHERE target.project_id = board_groups.project_id
                              AND target.name = 'Commit'),
       failure_group_id = (SELECT id FROM board_groups target
                            WHERE target.project_id = board_groups.project_id
                              AND target.name = 'For Review')
 WHERE name = 'Agent Review' AND project_id IN (SELECT project_id FROM upgradable);

UPDATE board_groups
   SET success_group_id = (SELECT id FROM board_groups target
                            WHERE target.project_id = board_groups.project_id
                              AND target.name = 'Completed'),
       failure_group_id = (SELECT id FROM board_groups target
                            WHERE target.project_id = board_groups.project_id
                              AND target.name = 'For Review')
 WHERE name = 'Commit' AND project_id IN (SELECT project_id FROM upgradable);

DROP TABLE upgradable;
