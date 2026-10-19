-- Stable opaque member identities; email continues to prove native sign-in.
ALTER TABLE c_members ADD COLUMN member_id TEXT;
UPDATE c_members SET member_id=lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6)));
CREATE UNIQUE INDEX c_members_identity ON c_members(member_id);
CREATE TRIGGER c_members_identity AFTER INSERT ON c_members WHEN NEW.member_id IS NULL BEGIN
 UPDATE c_members SET member_id=lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))) WHERE email=NEW.email;
END;
CREATE TABLE c_import_targets(kind TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(kind,id));
