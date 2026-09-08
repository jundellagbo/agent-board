-- Bring seeded boards onto the routing the columns are meant to have: a card
-- moves on only where a column explicitly says so, and a failure leaves it where
-- it was working rather than shuffling it back into the queue.
--
-- Only boards that are still the six seeded columns are touched; a board someone
-- has renamed or added to keeps whatever routing they gave it.
CREATE TEMP TABLE settleable AS
SELECT project_id
  FROM board_groups
 GROUP BY project_id
HAVING count(*) = 6
   AND sum(name IN ('Todo', 'In Progress', 'For Review', 'Agent Review', 'Commit', 'Completed')) = 6;

-- Nothing routes on failure any more.
UPDATE board_groups SET failure_group_id = NULL
 WHERE project_id IN (SELECT project_id FROM settleable);

-- Agent Review hands work forward only because a person moved it.
UPDATE board_groups SET success_group_id = NULL
 WHERE name = 'Agent Review' AND project_id IN (SELECT project_id FROM settleable);

-- A run started from the working lane finishes into review, like Todo's does.
UPDATE board_groups
   SET success_group_id = (SELECT id FROM board_groups target
                            WHERE target.project_id = board_groups.project_id
                              AND target.name = 'For Review')
 WHERE name = 'In Progress' AND project_id IN (SELECT project_id FROM settleable);

DROP TABLE settleable;
