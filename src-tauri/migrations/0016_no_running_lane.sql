-- Stop seeded boards moving a card into "In Progress" when its agent starts.
-- The card already says it is working, and the lane only ever held the one card
-- in flight. The column itself is left alone — it may hold cards, and removing
-- someone's column is their decision, not a migration's.
--
-- Only boards that are still the six seeded columns are touched; a board someone
-- has renamed or added to keeps whatever routing they gave it.
CREATE TEMP TABLE seeded AS
SELECT project_id
  FROM board_groups
 GROUP BY project_id
HAVING count(*) = 6
   AND sum(name IN ('Todo', 'In Progress', 'For Review', 'Agent Review', 'Commit', 'Completed')) = 6;

UPDATE board_groups SET running_group_id = NULL
 WHERE project_id IN (SELECT project_id FROM seeded);

DROP TABLE seeded;
