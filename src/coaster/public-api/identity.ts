/** Includes operator version and membership changes: old grants cannot spring back after reactivation. */
export const accessSnapshot = (m = 'm', o = 'o') => `json_array(${m}.updated_at,${m}.active,${m}.is_employee,${m}.is_manager,${m}.is_finance,${m}.is_auditor,${m}.is_admin,${m}.is_card_admin,${m}.is_bookkeeper,${m}.approver_email,${m}.department_id,${m}.may_release,${o}.id,${o}.version,${o}.role,${o}.status)`;
export const liveIdentity = `FROM c_members m JOIN oa_operators o ON lower(o.email)=m.email WHERE m.email=? AND m.active=1 AND o.status='active'`;
