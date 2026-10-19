-- Itemization, attendees and required fields (CLAIM-007). Each part of a split
-- names what it is (room, tax, in-room dining); categories may limit spend per
-- person and name custom fields every expense in them must fill.
ALTER TABLE c_allocations ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE c_categories ADD COLUMN per_person_limit_minor INTEGER CHECK (per_person_limit_minor IS NULL OR per_person_limit_minor >= 0);
ALTER TABLE c_categories ADD COLUMN required_fields TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_fields));
ALTER TABLE c_items ADD COLUMN attendees TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attendees));
ALTER TABLE c_items ADD COLUMN fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields));
