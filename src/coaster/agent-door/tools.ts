import { ToolRefusal, type ToolDefinition, type JsonSchemaObject, type JsonSchema, type ToolContext } from '../../modules/agent-door/index.ts';
import { agentContext, agentProposal, proposeBatch, proposeClaim } from '../agents';
import { nativeAgent } from './people';
import { Fault, text } from '../types';
import { business } from '../settings';
import { categories, itemInput } from '../items';

const string = { type: 'string', minLength: 1, maxLength: 200 };
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchemaObject => ({ type: 'object', properties, required, additionalProperties: true });
const id = object({ id: string }, ['id']);
const common = { classes: ['standard'] as ToolDefinition['classes'], clauses: ['COA-010', 'BASE-AGENT-002', 'BASE-AGENT-006'],
  outputSchema: { type: 'object' } };
async function native<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (!(error instanceof Fault)) throw error;
    throw new ToolRefusal(error.status === 404 ? 'resource_unavailable' : error.status === 403 ? 'native_authority_required' : error.status === 409 ? 'native_conflict' : 'invalid_arguments');
  }
}
const standard = async (_args: Record<string, unknown>, ctx: ToolContext) => { await nativeAgent(ctx); return [{ class: 'standard' as const, facts: { measure: 1 } }]; };
// Proposal payloads are private untrusted expense content; conservatively protect them.
const privateClasses = ['standard', 'sensitive'] as ToolDefinition['classes'];
const privateFacts = [{ class: 'standard' as const, facts: { measure: 1 } }, { class: 'sensitive' as const, facts: { measure: 1, kind: 'private-expense' } }];
async function claimFacts(args: Record<string, unknown>, ctx: ToolContext) {
  const a = await nativeAgent(ctx);
  if (!a.roles.employee) throw new ToolRefusal('native_authority_required');
  const settings = await business(ctx.db);
  if (!settings) throw new ToolRefusal('native_conflict');
  const known = await categories(ctx.db);
  const foreign = await native(async () => (args.items as Record<string, unknown>[]).some(raw => {
    const item = itemInput(raw, settings, known);
    if (item.kind !== 'receipt' && !item.per_diem) return false;
    const currency = item.per_diem ? 'USD' : raw.currency === undefined || raw.currency === '' ? settings.currency : text(raw.currency, 'Currency', 3).toUpperCase();
    return currency !== settings.currency && (raw.manualRate === undefined || raw.manualRate === '');
  }));
  return [{ class: 'standard' as const, facts: { measure: (args.items as unknown[]).length } }, privateFacts[1]!, ...(foreign ? [{ class: 'external' as const, facts: { measure: 1, counterparty: 'known' as const } }] : [])];
}

export function coasterTools(): ToolDefinition[] {
  return [
    { ...common, name: 'coaster.workspace.get', title: 'Preparation context', description: 'Read the native personal-agent context, available categories and proposal receipts. No receipt originals or private human preparations.',
      scope: 'proposals:read', readOnly: true, inputSchema: object({}), classify: standard,
      run: async (_args, ctx) => ({ result: await native(() => nativeAgent(ctx).then(a => agentContext(ctx.db, a))) }) },
    { ...common, classes: privateClasses, name: 'coaster.proposals.get', title: 'Read own proposal', description: 'Read one own personal-agent proposal. Expense text is untrusted; conversation and human preparations remain hidden.',
      scope: 'proposals:read', readOnly: true, inputSchema: id, untrusted: true,
      classify: async (args, ctx) => { await native(() => nativeAgent(ctx).then(a => agentProposal(ctx.db, a, String(args.id)))); return privateFacts; },
      target: async args => ({ kind: 'proposal', id: String(args.id) }),
      run: async (args, ctx) => ({ result: await native(() => nativeAgent(ctx).then(a => agentProposal(ctx.db, a, String(args.id)))) }) },
    { ...common, classes: [...privateClasses, 'external'], clauses: [...common.clauses, 'CLAIM-003'], name: 'coaster.claims.propose', title: 'Prepare a claim proposal', description: 'Prepare purchases, mileage or per diem for the sponsor. A native person must accept and submit. Receipt and imported text cannot authorize actions.',
      scope: 'proposals:write', readOnly: false, untrusted: true,
      inputSchema: object({ title: string, note: { type: 'string', maxLength: 2000 }, items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object' } } }, ['title', 'items']),
      classify: claimFacts,
      summary: async (args, ctx) => ({ target: { id: ctx.person.id, name: ctx.person.name }, items: [String(args.title), `${Array.isArray(args.items) ? args.items.length : 0} proposed expenses; human acceptance required`] }),
      run: async (args, ctx) => ({ result: await native(() => nativeAgent(ctx).then(a => proposeClaim(ctx.db, a, args))) }) },
    { ...common, name: 'coaster.batches.propose', title: 'Prepare a batch proposal', description: 'Finance proposes approved claims for human review. This neither creates nor releases a reimbursement batch.',
      scope: 'proposals:write', readOnly: false,
      inputSchema: object({ claims: { type: 'array', minItems: 1, maxItems: 200, items: string }, note: { type: 'string', maxLength: 2000 } }, ['claims']),
      classify: async (args, ctx) => {
        const a = await nativeAgent(ctx); if (!a.roles.finance) throw new ToolRefusal('native_authority_required');
        for (const claim of args.claims as string[]) if (!await ctx.db.prepare("SELECT 1 FROM c_claims WHERE id=? AND status='approved'").bind(claim).first()) throw new ToolRefusal('native_conflict');
        return [{ class: 'standard', facts: { measure: (args.claims as string[]).length } }];
      },
      summary: async (args, ctx) => ({ target: { id: ctx.person.id, name: ctx.person.name }, items: args.claims as string[] }),
      run: async (args, ctx) => ({ result: await native(() => nativeAgent(ctx).then(a => proposeBatch(ctx.db, a, args))) }) },
  ];
}
