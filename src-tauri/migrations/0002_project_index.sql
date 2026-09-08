-- Full-text index of a project's source files, used to answer "where is X?"
-- without shelling out to a grep for every question. Rebuilt wholesale on
-- re-index, so it needs no per-file bookkeeping.
CREATE VIRTUAL TABLE project_files USING fts5(
  project_id UNINDEXED,
  path,
  content,
  tokenize = 'unicode61'
);
