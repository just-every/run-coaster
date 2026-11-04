import { coasterTools } from './tools';
import { coasterResources } from './resources';
import { coasterPrompts } from './prompts';
import { agentCapacity } from './limits';

/** Only public conformance declarations enter the documentation projection. */
export interface AgentSurface {
  specialist: string;
  tools: Array<{ name: string; scope: string; readOnly: boolean; classes: string[]; clauses: string[] }>;
  resources: string[];
  prompts: string[];
  witness: { tool: string; args: Record<string, unknown> };
  verification: {
    owner: { initializer: string };
    reviewers?: Array<{ initializer?: string }>;
    sponsors?: Array<{ initializer?: string }>;
    fixtures: { module: string };
    network?: { module: string };
    journey: string;
  };
  journey: Array<{
    id: string; tool: string; args: Record<string, unknown>;
    expect: Array<{ class: string; facts: Record<string, unknown> }>;
    target?: unknown;
  }>;
}

export const catalogueStart = '<!-- coaster-agent-catalogue:start -->';
export const catalogueEnd = '<!-- coaster-agent-catalogue:end -->';
function fail(message: string): never { throw new Error(`Agent catalogue: ${message}`); }
const sameMembers = (actual: readonly string[], expected: readonly string[], label: string) => {
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length ||
      JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) fail(`${label} disagrees with the native registry`);
};

function references(value: unknown, previous: ReadonlySet<string>, where: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(child => references(child, previous, where)); return; }
  const record = value as Record<string, unknown>;
  if ('$from' in record) {
    if (typeof record.$from !== 'string' || !previous.has(record.$from)) fail(`${where} references an unavailable journey`);
    if (typeof record.pointer !== 'string' || !/^(?:\/(?:[^~]|~[01])*)*$/.test(record.pointer)) fail(`${where} has an invalid fixture JSON pointer`);
  }
  Object.values(record).forEach(child => references(child, previous, where));
}

/** Files which the docs build must check and watch alongside the journey declaration. */
export function agentFixtureFiles(surface: AgentSurface): string[] {
  const verification = surface.verification;
  const files = [verification.owner.initializer, verification.fixtures.module, verification.journey,
    ...(verification.network ? [verification.network.module] : []),
    ...[...verification.reviewers ?? [], ...verification.sponsors ?? []].flatMap(person => person.initializer ? [person.initializer] : [])];
  for (const file of files) {
    if (typeof file !== 'string' || !file.startsWith('tests/') || !file.endsWith('.mjs') || file.split('/').some(part => !part || part === '..' || part === '.') || file.includes('\\')) {
      fail('verification references must name repository test modules');
    }
  }
  return [...new Set(files)];
}

/** Compare declarations before projecting the actual native registry, never a second tool catalogue. */
export function agentCatalogue(surface: AgentSurface) {
  const tools = coasterTools().sort((a, b) => a.name.localeCompare(b.name));
  const resources = coasterResources().sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate));
  const prompts = coasterPrompts(tools);
  sameMembers(surface.tools.map(tool => tool.name), tools.map(tool => tool.name), 'tool names');
  sameMembers(surface.resources, resources.map(resource => resource.uriTemplate), 'resource templates');
  sameMembers(surface.prompts, prompts.map(prompt => prompt.name), 'prompt names');
  for (const tool of tools) {
    const declaration = surface.tools.find(candidate => candidate.name === tool.name)!;
    if (declaration.scope !== tool.scope || declaration.readOnly !== tool.readOnly) fail(`${tool.name} scope or readOnly disagrees with the native registry`);
    sameMembers(declaration.classes, tool.classes, `${tool.name} declared classes`);
    sameMembers(declaration.clauses, tool.clauses, `${tool.name} clauses`);
  }
  if (!tools.some(tool => tool.name === surface.witness.tool)) fail('witness references an unknown tool');
  references(surface.witness.args, new Set(), 'witness');
  const previous = new Set<string>();
  for (const journey of surface.journey) {
    if (typeof journey.id !== 'string' || !journey.id || previous.has(journey.id)) fail('journey ids must be nonempty and unique');
    const tool = tools.find(candidate => candidate.name === journey.tool) ?? fail(`${journey.id} references an unknown tool`);
    const classes = journey.expect.map(item => item.class);
    if (!classes.length || new Set(classes).size !== classes.length || classes.some(cls => !tool.classes.includes(cls as typeof tool.classes[number]))) {
      fail(`${journey.id} computed classes disagree with ${tool.name}`);
    }
    references(journey.args, previous, journey.id);
    references(journey.target, previous, journey.id);
    previous.add(journey.id);
  }
  return {
    specialist: surface.specialist,
    tools: tools.map(({ name, title, description, scope, readOnly, classes, clauses }) => ({
      name, title, description, scope, readOnly, classes, clauses,
      witnesses: classes.map(cls => {
        const journeys = surface.journey.filter(journey => journey.tool === name && journey.expect.some(item => item.class === cls)).map(journey => journey.id);
        if (!journeys.length) fail(`${name} class ${cls} has no proving journey`);
        return { class: cls, journeys };
      }),
    })),
    resourceTemplates: resources.map(({ uriTemplate, name, description, scope, classes }) => ({ uriTemplate, name, description, scope, classes })),
    prompts: prompts.map(({ name, title, description }) => ({ name, title, description })),
    journeys: surface.journey.map(({ id, tool, args, expect }) => ({ id, tool, args, expect })),
    fixtureFiles: agentFixtureFiles(surface),
  };
}

const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
const code = (value: string) => `\`${cell(value).replaceAll('`', '&#96;')}\``;
const codes = (values: readonly string[]) => values.map(code).join(', ');

function condition(args: Record<string, unknown>, classes: string[]): string {
  const items = Array.isArray(args.items) ? args.items as Array<Record<string, unknown>> : [];
  if (items.some(item => item.manualRate !== undefined && item.manualRate !== '')) {
    return 'Explicit manual FX rate; no provider request and no external class.';
  }
  if (classes.includes('external')) return 'Automatic foreign-currency FX; public ECB history request, without expense or person data.';
  if (items.length) return 'Native expense preparation; private untrusted expense content.';
  if (Array.isArray(args.claims)) return 'Finance preparation from already-approved native claims; no batch release.';
  if ('id' in args) return 'Read the sponsoring person’s own proposal; private untrusted expense content.';
  if (!classes.includes('sensitive')) return 'Read a content-free fingerprint of the sponsoring person’s native preparation context.';
  return 'Read the sponsoring person’s native preparation context.';
}

export function agentCatalogueMarkdown(surface: AgentSurface): string {
  const catalogue = agentCatalogue(surface);
  const lines = [
    '## MCP catalogue', '',
    `Specialist: **${cell(catalogue.specialist)}**. This section is generated from the native tool, resource and prompt registries and checked against \`agent-surface.json\` at docs build time.`, '',
    'The names below are the complete declared catalogue. Current scopes, membership and company policy still govern discovery and every call.', '',
    '### Installation capacity', '',
    '| Capacity | Limit in force |',
    '| --- | --- |',
    `| Admitted authenticated MCP requests per agent per minute | ${agentCapacity.requestsPerMinute} |`,
    `| Maximum MCP request body in bytes | ${agentCapacity.maxBodyBytes} |`, '',
    'The request allowance is shared by authenticated catalogue reads and tool calls for the same agent, across supported protocol versions and JSON-RPC ids. It resets at the next UTC minute boundary. An overrun returns HTTP 429 with code `rate_limited` and a positive `Retry-After` in seconds until that boundary, before preparation or provider access. Other agents and native browser sessions retain access.', '',
    'The body limit counts the complete UTF-8 request body; an oversized body returns HTTP 413 before tool execution. These rate and size capacities protect the installation. They are not daily business-volume limits, recipient thresholds or provider-spend caps. Spend and grant byte budgets, per-day recipient thresholds and complete per-agent money and provider-spend usage remain unqualified.', '',
    '### Tools by job', '',
    '| Job | Tool | Scope | Classes | Clauses |',
    '| --- | --- | --- | --- | --- |',
    ...catalogue.tools.map(tool => `| ${cell(tool.title)} | ${code(tool.name)} | ${code(tool.scope)} | ${codes(tool.classes)} | ${codes(tool.clauses)} |`), '',
    '### Class witnesses', '',
    'Each case below is an entry in the production-door conformance journey in `agent-surface.json`. The expectation records the computed class and facts; fixture inputs cannot grant a class or perform a person’s step.', '',
    '| Tool | Computed class | Proving journey cases |',
    '| --- | --- | --- |',
    ...catalogue.tools.flatMap(tool => tool.witnesses.map(witness => `| ${code(tool.name)} | ${code(witness.class)} | ${codes(witness.journeys)} |`)), '',
    '| Journey case | Tool | Expected computed classes | Native condition |',
    '| --- | --- | --- | --- |',
    ...catalogue.journeys.map(journey => `| ${code(journey.id)} | ${code(journey.tool)} | ${codes(journey.expect.map(item => item.class))} | ${condition(journey.args, journey.expect.map(item => item.class))} |`), '',
    'Verification modules: ' + codes(catalogue.fixtureFiles) + '.', '',
    '### Resource templates', '',
    '| Name | Template | Scope | Classes |',
    '| --- | --- | --- | --- |',
    ...catalogue.resourceTemplates.map(resource => `| ${cell(resource.name)} | ${code(resource.uriTemplate)} | ${resource.scope ? code(resource.scope) : 'None'} | ${codes(resource.classes)} |`), '',
    '### Specialist prompt jobs', '',
    '| Job | Prompt | Instructions |',
    '| --- | --- | --- |',
    ...catalogue.prompts.map(prompt => `| ${cell(prompt.title ?? prompt.name)} | ${code(prompt.name)} | ${cell(prompt.description)} |`), '',
    'These static prompts accept no arguments, read no private records and perform no action. They grant no scope. Claim acceptance and submission, approval, batch review and payment remain separate native human controls.',
  ];
  return lines.join('\n');
}

/** Replace only the explicitly generated region, retaining all surrounding owner guidance. */
export function renderAgentCatalogue(markdown: string, surface: AgentSurface): string {
  const start = markdown.indexOf(catalogueStart), end = markdown.indexOf(catalogueEnd);
  if (start < 0 || end < start || markdown.indexOf(catalogueStart, start + catalogueStart.length) >= 0 || markdown.indexOf(catalogueEnd, end + catalogueEnd.length) >= 0) {
    fail('docs/agents.md must contain exactly one catalogue marker pair');
  }
  return markdown.slice(0, start) + `${catalogueStart}\n\n${agentCatalogueMarkdown(surface)}\n\n${catalogueEnd}` + markdown.slice(end + catalogueEnd.length);
}
