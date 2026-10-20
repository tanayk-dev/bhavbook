-- 0004_unique_tag_names: the database itself refuses a second setup or mistake tag whose name differs only in
-- ASCII case (S13a-3b). Like 0003, the service folds Unicode case before inserting; this index is the backstop when
-- two processes race.

CREATE UNIQUE INDEX tag_name_unique ON tag (kind, lower(name));
