import { createBusinessSettings, type TeamAdapter } from '../../modules/business-settings/index.ts';
import type { Bindings } from '../../auth.server';

/** Link existing native accounts only. Business settings never manufacture Coaster grants. */
export function coasterBusiness(env: Bindings) {
  const team: TeamAdapter = {
    async ownerEmail() { return (await env.DB.prepare("SELECT email FROM oa_operators WHERE role='owner' AND status='active' ORDER BY created_at,id LIMIT 1").first<{email: string}>())?.email ?? null; },
    async prepare({ members, managed }) {
      const rows = [];
      for (const m of members) {
        const prior = managed.find(row => row.businessId === m.id || row.email === m.email);
        const native = prior?.operatorId
          ? await env.DB.prepare('SELECT id,email,status FROM oa_operators WHERE id=?').bind(prior.operatorId).first<{id: string; email: string; status: string}>()
          : await env.DB.prepare('SELECT id,email,status FROM oa_operators WHERE lower(email)=?').bind(m.email).first<{id: string; email: string; status: string}>();
        const active = native && native.email.toLowerCase() === m.email && native.status === 'active' && await env.DB.prepare('SELECT 1 FROM c_members WHERE email=? AND active=1').bind(m.email).first();
        rows.push({ email: m.email, operatorId: native?.id ?? null, invite: m.invite, businessId: m.id ?? prior?.businessId, businessRole: m.role,
          state: active ? 'active' as const : 'conflict' as const });
      }
      return { statements: [], rows, async afterCommit() {} };
    },
  };
  return createBusinessSettings({ db: env.DB, trust: env.RER_BUSINESS_TRUST ?? null, business: { settings: 1, values: ['display_name'], team: { roles: { admin: 'admin', member: 'member' } } }, team });
}
