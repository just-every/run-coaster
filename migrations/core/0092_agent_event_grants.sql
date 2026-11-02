-- Existing personal keys keep their preparation grants. Event access needs new consent.
ALTER TABLE c_agent_keys ADD COLUMN scopes TEXT NOT NULL
  DEFAULT '["proposals:read","proposals:write"]'
  CHECK(json_valid(scopes) AND json_type(scopes) = 'array');
