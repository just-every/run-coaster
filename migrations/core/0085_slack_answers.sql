CREATE TABLE c_slack_connection (
 id TEXT PRIMARY KEY,
 singleton INTEGER NOT NULL UNIQUE DEFAULT 1 CHECK(singleton=1),
 team TEXT NOT NULL,
 app TEXT NOT NULL,
 workspace TEXT NOT NULL,
 credentials TEXT NOT NULL,
 connected_at TEXT NOT NULL
);
CREATE TABLE c_slack_links (
 member_id TEXT PRIMARY KEY,
 connection_id TEXT NOT NULL REFERENCES c_slack_connection(id) ON DELETE CASCADE,
 user TEXT NOT NULL,
 UNIQUE(connection_id,user)
);
CREATE TABLE c_slack_challenges (
 member_id TEXT PRIMARY KEY,
 connection_id TEXT NOT NULL REFERENCES c_slack_connection(id) ON DELETE CASCADE,
 user TEXT NOT NULL,
 code_hash TEXT NOT NULL,
 expires INTEGER NOT NULL
);
CREATE TABLE c_slack_threads (
 question_id TEXT PRIMARY KEY REFERENCES c_comments(id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES c_slack_connection(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES c_slack_links(member_id) ON DELETE CASCADE,
 channel TEXT NOT NULL,
 thread TEXT NOT NULL,
 revision INTEGER NOT NULL,
 UNIQUE(connection_id,channel,thread)
);
CREATE TABLE c_slack_answers (
 digest TEXT PRIMARY KEY CHECK(length(digest)=64),
 comment_id TEXT UNIQUE REFERENCES c_comments(id) ON DELETE SET NULL
);
-- Execution authority is removed atomically with the ordinary member erasure.
CREATE TRIGGER c_slack_erasure AFTER INSERT ON c_erasing BEGIN
 DELETE FROM c_slack_challenges WHERE member_id IN (SELECT member_id FROM c_members WHERE email=NEW.email);
 DELETE FROM c_slack_threads WHERE question_id IN (SELECT id FROM c_comments WHERE author_email=NEW.email OR asks_email=NEW.email);
 DELETE FROM c_slack_links WHERE member_id IN (SELECT member_id FROM c_members WHERE email=NEW.email);
END;
