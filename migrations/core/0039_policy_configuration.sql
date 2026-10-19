-- Owner settings become immutable configuration snapshots of POLICY-001 versions.
CREATE TABLE c_policy_configurations (
  version INTEGER PRIMARY KEY REFERENCES c_policies(version),
  configuration TEXT NOT NULL CHECK(json_valid(configuration))
);
INSERT INTO c_policies(version,effective_from,rules,published_by,published_at)
SELECT 1,substr(updated_at,1,10),'[]','migration',updated_at FROM c_business WHERE id=1 AND NOT EXISTS(SELECT 1 FROM c_policies);
INSERT INTO c_policy_configurations(version,configuration)
SELECT p.version,json_object('legacy_capture',1,'receipt_threshold_minor',b.receipt_threshold_minor,'preapproval_threshold_minor',b.preapproval_threshold_minor,'categories',json(COALESCE((SELECT json_group_array(json_object('id',id,'name',name,'active',active,'limit_minor',limit_minor,'per_person_limit_minor',per_person_limit_minor,'receipt_always',receipt_always,'required_fields',json(required_fields))) FROM c_categories),'[]'))) FROM c_policies p CROSS JOIN c_business b WHERE b.id=1;
CREATE TRIGGER c_policy_configuration_permanent BEFORE UPDATE ON c_policy_configurations BEGIN SELECT RAISE(ABORT, 'policy configuration is permanent'); END;
CREATE TRIGGER c_policy_configuration_no_delete BEFORE DELETE ON c_policy_configurations BEGIN SELECT RAISE(ABORT, 'policy configuration is permanent'); END;
