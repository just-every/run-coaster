import type { JsonSchema, JsonSchemaObject } from '../../modules/agent-door/index.ts';

const string: JsonSchema = { type: 'string' };
const identifier: JsonSchema = { type: 'string', minLength: 1 };
const boolean: JsonSchema = { type: 'boolean' };
const nil: JsonSchema = { type: 'null' };
const date: JsonSchema = { type: 'string', format: 'date' };
const timestamp: JsonSchema = { type: 'string', format: 'date-time' };
const currency: JsonSchema = { type: 'string', pattern: '^[A-Z]{3}$' };
const integer = (minimum: number, maximum?: number): JsonSchema => ({ type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }) });
const minor = integer(0);
const flag: JsonSchema = { type: 'integer', enum: [0, 1] };
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, nil] });
const array = (items: JsonSchema, limits: Record<string, number> = {}): JsonSchema => ({ type: 'array', items, ...limits });
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties), additionalProperties = false): JsonSchemaObject =>
  ({ type: 'object', properties, required, additionalProperties });
const optionalText = (maxLength: number): JsonSchema => nullable({ type: 'string', maxLength });
const decimal: JsonSchema = { type: ['string', 'number'] };
const blankOrNull = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, nil, { const: '' }] });

const business = object({
  fx_enabled: flag, name: identifier, currency, timezone: identifier,
  per_diem_minor: minor, receipt_threshold_minor: minor,
  sales_tax_account: string, sales_tax_code: string,
  preapproval_threshold_minor: nullable(minor), audit_sample_percent: nullable(integer(1, 100)),
  reminder_days: array(integer(1)), quiet_from: integer(0, 23), quiet_until: integer(0, 23),
  service_level_days: integer(1, 30), escalation_days: nullable(integer(1, 30)),
  auto_submit: { enum: ['daily', 'weekly', 'twice-monthly', 'monthly', null] },
  retention_years: integer(1, 30), dual_release_over_minor: nullable(minor),
  pay_weekday: nullable(integer(0, 6)), advance_account: string,
  mileage_rates: array(object({ effective_from: date, rate_thousandths: integer(1) })),
});

const categoryAccount = object({
  id: identifier, dimension: identifier, name: identifier,
  source: { enum: ['native', 'quickbooks'] }, sourceCompany: string, sourceId: string, selectedAt: timestamp,
});
const category = object({
  id: identifier, name: identifier, account_code: string, tax_code: string,
  limit_minor: nullable(minor), active: { const: 1 }, receipt_always: flag,
  per_person_limit_minor: nullable(minor), required_fields: array(string),
  ledger_account_id: nullable(identifier), ledger_account_snapshot: string,
  ledger_account: nullable(categoryAccount), ledger_account_available: boolean,
}, ['id', 'name', 'account_code', 'tax_code', 'limit_minor', 'active', 'receipt_always', 'per_person_limit_minor', 'required_fields']);

const status: JsonSchema = { enum: ['proposed', 'accepted', 'declined'] };
const kind: JsonSchema = { enum: ['claim', 'batch'] };
const proposalSummary = object({
  id: identifier, kind, status, created_at: timestamp,
  decided_at: nullable(timestamp), result_id: nullable(identifier),
});

/** The context is the native projection, including summaries of human preparations. */
export const agentContextOutputSchema: JsonSchemaObject = object({
  for: object({ email: identifier, name: string, roles: object({
    employee: boolean, manager: boolean, finance: boolean, owner: boolean,
    auditor: boolean, admin: boolean, cardAdmin: boolean, bookkeeper: boolean,
  }) }),
  agent: string, business: nullable(business), categories: array(category),
  approvedClaims: array(object({
    id: identifier, number: integer(1), employee_email: identifier, title: string,
    total_minor: minor, currency,
  })),
  proposals: array(proposalSummary, { maxItems: 50 }),
});

const allocation = object({
  category: identifier, costCentre: optionalText(80), description: optionalText(200),
  amount: blankOrNull(decimal),
}, ['category'], true);
const attendee: JsonSchema = {
  oneOf: [
    object({ kind: { const: 'employee' }, name: identifier, email: identifier }, ['kind', 'name', 'email'], true),
    // Guest email and other unconsumed fields are retained verbatim by prepareClaim.
    object({ kind: { const: 'guest' }, name: identifier }, ['kind', 'name'], true),
  ],
};
const meals: JsonSchema = { enum: ['breakfast', 'lunch', 'dinner'] };
const perDiem = object({
  method: { enum: ['gsa', 'state', 'high-low'] }, locationId: identifier, endDate: date,
  component: { enum: ['mie', 'lodging', 'both', null] },
  providedMeals: nullable(array(object({ date, meals: array(meals, { maxItems: 3 }) }, ['date', 'meals'], true), { maxItems: 60 })),
}, ['method', 'locationId', 'endDate'], true);

const nonemptyAllocations = array(allocation, { minItems: 1, maxItems: 10 });
const allocationChoice: JsonSchema = {
  anyOf: [
    object({ allocations: nonemptyAllocations }, ['allocations'], true),
    // Native input uses the single category whenever allocations is empty or not an array.
    { ...object({ category: identifier }, ['category'], true),
      not: object({ allocations: { type: 'array', minItems: 1 } }, ['allocations'], true) },
  ],
};

/** These are preserved inputs, not normalized ItemInput rows. Only the receipt
 * bytes are removed; receiptId and the priced integer amountMinor are added.
 * Constraints apply to fields consumed for that kind. Unused native inputs and
 * arbitrary additional fields must remain representable in the projection. */
const claimItem: JsonSchema = {
  ...object({
    kind: { enum: ['receipt', 'mileage', 'per_diem'] }, date,
    description: optionalText(500), explanation: optionalText(1000),
    billable: boolean, customer: optionalText(200), project: optionalText(200),
    attendees: blankOrNull(array(attendee, { maxItems: 50 })),
    fields: blankOrNull({ type: 'object', maxProperties: 20, additionalProperties: optionalText(300) }),
    coding: blankOrNull({ type: 'object', maxProperties: 40, additionalProperties: identifier }),
    receiptId: nullable(identifier), amountMinor: integer(1),
  }, ['kind', 'date', 'receiptId', 'amountMinor'], true),
  allOf: [allocationChoice, {
    oneOf: [
      object({ kind: { const: 'receipt' }, merchant: identifier, amount: decimal,
        salesTax: blankOrNull(decimal), currency: { type: 'string', maxLength: 3 },
      }, ['kind', 'merchant', 'amount'], true),
      object({ kind: { const: 'mileage' }, distance: decimal, merchant: optionalText(200) }, ['kind', 'distance'], true),
      { ...object({ kind: { const: 'per_diem' } }, ['kind'], true), anyOf: [
        object({ perDiem }, ['perDiem'], true),
        object({
          perDiem: { enum: [null, false, '', 0] }, merchant: optionalText(200),
          // Native company-rate days use Number(), retaining the entered value.
          days: { anyOf: [decimal, { const: true }, array(decimal, { minItems: 1, maxItems: 1 })] },
        }, ['days'], true),
      ] },
    ],
  }],
};

const claimPayload = object({
  nativeConversation: boolean, title: identifier, note: string,
  items: array(claimItem, { minItems: 1, maxItems: 50 }),
}, ['title', 'note', 'items'], true);
const batchPayload = object({ claims: array(identifier, { minItems: 1, maxItems: 200 }), note: string }, undefined, true);

const decisionStates: JsonSchema = {
  oneOf: [
    object({ status: { const: 'proposed' }, decided_by: nil, decided_at: nil, result_id: nil }, undefined, true),
    object({ status: { const: 'accepted' }, decided_by: identifier, decided_at: timestamp, result_id: identifier }, undefined, true),
    object({ status: { const: 'declined' }, decided_by: identifier, decided_at: timestamp, result_id: nil }, undefined, true),
  ],
};

function proposalOf(proposalKind: 'claim' | 'batch', payload: JsonSchema): JsonSchemaObject {
  return {
    ...object({
      id: identifier, kind: { const: proposalKind }, agent_label: string, for_email: identifier,
      payload, status, created_at: timestamp, decided_by: nullable(identifier),
      decided_at: nullable(timestamp), result_id: nullable(identifier),
    }),
    allOf: [decisionStates],
  };
}

export const proposeClaimOutputSchema = proposalOf('claim', claimPayload);
export const proposeBatchOutputSchema = proposalOf('batch', batchPayload);

/** Own personal-agent proposals retain the same claim or batch projection in
 * each native decision state. Human preparation payloads are excluded natively. */
export const agentProposalOutputSchema: JsonSchemaObject = {
  type: 'object', oneOf: [proposeClaimOutputSchema, proposeBatchOutputSchema],
};
