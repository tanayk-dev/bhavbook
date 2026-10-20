-- 0003_unique_labels: the database itself refuses a second profile name in one PAN entity, or a second account
-- nickname in one profile, ignoring ASCII case (S13a-2 review). Labels are stored NFC-normalised by the service,
-- which also folds non-ASCII case before inserting; these indexes are the backstop when two processes race.

CREATE UNIQUE INDEX profile_name_unique ON profile (pan_entity_id, lower(name));
CREATE UNIQUE INDEX broker_account_nickname_unique ON broker_account (profile_id, lower(nickname));
