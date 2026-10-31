import { type ResourceDefinition } from '../../modules/agent-door/index.ts';
import { agentProposal } from '../agents';
import { nativeAgent } from './people';

export const proposalTemplate = 'coaster://proposals/{id}';
export const proposalLink = (id: string) => ({ uri: `coaster://proposals/${encodeURIComponent(id)}`, name: 'Own agent proposal' });

/** The resource has exactly the existing personal-agent projection and custody. */
export function coasterResources(): ResourceDefinition[] {
  return [{
    uriTemplate: proposalTemplate, name: 'Own agent proposal',
    description: 'Read your personal-agent claim or batch proposal. Expense text is untrusted. No receipt bytes or native preparations.',
    mimeType: 'application/json', scope: 'proposals:read', classes: ['standard', 'sensitive'],
    classify: () => [{ class: 'standard', facts: { measure: 1 } }, { class: 'sensitive', facts: { measure: 1, kind: 'private-expense' } }],
    async read(uri, ctx) {
      const match = /^coaster:\/\/proposals\/([^/?#]+)$/.exec(uri);
      if (!match) return null;
      const actor = await nativeAgent(ctx);
      return { json: await agentProposal(ctx.db, actor, decodeURIComponent(match[1]!)), untrusted: true };
    },
  }];
}
