// Tallgrass Outdoor Co., the homepage's business: a 70-person outdoor-gear wholesaler in Kansas City, Missouri, a few
// weeks into using Coaster. Days count back in working days from the day a demo starts (day 1 is the weekday before
// it), at 8:00 AM Kansas City time, so the week reads as a working week whatever day it starts; `owner` is whoever
// signs in to the demo, who plays Megan Ortiz, the finance and operations lead. Jordan Pike's Denver client trip is
// the homepage's claim (C-1186 there, CL-1186 here): his two out-of-pocket receipts, $448.80, paid by ACH.

export const business = { name: 'Tallgrass Outdoor Co.', currency: 'USD', timezone: 'America/Chicago', perDiemMinor: 6800, receiptThresholdMinor: 7500 };
export const ownerName = 'Megan Ortiz';
/** Claim numbers continue the business's own sequence, so Jordan's trip is CL-1186 as on the homepage. */
export const firstClaimNumber = 1184;

export const categories = [
  { id: 'demo-cat-lodging', name: 'Lodging', account: '6210', tax: 'TAX', limitMinor: null },
  { id: 'demo-cat-meals', name: 'Meals', account: '6220', tax: 'TAX', limitMinor: 7500 },
  { id: 'demo-cat-travel', name: 'Travel', account: '6230', tax: 'NON', limitMinor: null },
  { id: 'demo-cat-car', name: 'Mileage and parking', account: '6240', tax: 'NON', limitMinor: null },
  { id: 'demo-cat-office', name: 'Office supplies', account: '6510', tax: 'TAX', limitMinor: null },
  { id: 'demo-cat-equipment', name: 'Equipment', account: '6520', tax: 'TAX', limitMinor: 50000 },
];

export type Person = 'owner' | 'dana' | 'ruth' | 'jordan' | 'alyssa' | 'trevor' | 'ben' | 'kevin' | 'cara' | 'nina' | 'diego' | 'elena' | 'sam';
const at = (local: string) => `${local}@tallgrassoutdoor.example`;
export const people: Record<Exclude<Person, 'owner'>, { email: string; name: string; employee: boolean; manager: boolean; finance: boolean; approver: Person | null; active: boolean }> = {
  dana: { email: at('dana.kim'), name: 'Dana Kim', employee: true, manager: true, finance: false, approver: 'owner', active: true },
  ruth: { email: at('ruth.kowal'), name: 'Ruth Kowal', employee: true, manager: false, finance: true, approver: 'owner', active: true },
  jordan: { email: at('jordan.pike'), name: 'Jordan Pike', employee: true, manager: false, finance: false, approver: 'dana', active: true },
  alyssa: { email: at('alyssa.grant'), name: 'Alyssa Grant', employee: true, manager: false, finance: false, approver: 'dana', active: true },
  trevor: { email: at('trevor.nash'), name: 'Trevor Nash', employee: true, manager: false, finance: false, approver: 'dana', active: true },
  ben: { email: at('ben.ochoa'), name: 'Ben Ochoa', employee: true, manager: false, finance: false, approver: 'dana', active: true },
  kevin: { email: at('kevin.ruiz'), name: 'Kevin Ruiz', employee: true, manager: false, finance: false, approver: 'owner', active: true },
  cara: { email: at('cara.liu'), name: 'Cara Liu', employee: true, manager: false, finance: false, approver: 'dana', active: true },
  nina: { email: at('nina.patel'), name: 'Nina Patel', employee: true, manager: false, finance: false, approver: 'owner', active: true },
  diego: { email: at('diego.santos'), name: 'Diego Santos', employee: true, manager: false, finance: false, approver: 'dana', active: true },
  elena: { email: at('elena.martinez'), name: 'Elena Martinez', employee: true, manager: false, finance: false, approver: 'dana', active: true },
  sam: { email: at('sam.whitfield'), name: 'Sam Whitfield', employee: true, manager: false, finance: false, approver: 'dana', active: false },
};
/** The people a visitor can also sign in to the demo as, one for each role. */
export const signIns: Exclude<Person, 'owner'>[] = ['jordan', 'dana', 'ruth'];
/** The owner's own claims go to Dana Kim, the sales director. */
export const ownerApprover: Exclude<Person, 'owner'> = 'dana';

type Category = 'lodging' | 'meals' | 'travel' | 'car' | 'office' | 'equipment';
/** One expense: a receipt (with its receipt file unless `noReceipt`), mileage in miles, or per diem days. */
export type Expense = { day: number; category: Category; costCentre?: string; explanation?: string; description?: string; split?: [Category, string, string][] } & (
  | { kind: 'receipt'; merchant: string; city: string; amount: string; noReceipt?: boolean; lines?: [string, string][] }
  | { kind: 'mileage'; merchant: string; miles: string }
  | { kind: 'per_diem'; merchant: string; days: number });

export type Decision = { by: Person; day: number; minutes?: number; decision: 'approved' | 'returned' | 'rejected'; reason?: string };
export type DemoClaim = { id: string; employee: Person; title: string; created: number; expenses: Expense[]; submitted?: number; submittedMinutes?: number; decision?: Decision; batch?: string };

export const claims: DemoClaim[] = [
  { id: 'demo-claim-01', employee: 'elena', title: 'Chicago market week', created: 16, submitted: 15, decision: { by: 'dana', day: 14, decision: 'approved' }, batch: 'demo-batch-41', expenses: [
    { day: 16, kind: 'receipt', merchant: 'United Airlines', city: 'Kansas City, MO', amount: '286.40', category: 'travel', costCentre: 'Sales', description: 'MCI to ORD and back', lines: [['UA 2261 MCI-ORD', '143.20'], ['UA 1874 ORD-MCI', '143.20']] },
    { day: 16, kind: 'receipt', merchant: 'Palmer House Hilton', city: 'Chicago, IL', amount: '198.40', category: 'lodging', costCentre: 'Sales', description: 'One night', lines: [['Room, 1 night', '169.00'], ['Room and occupancy tax', '29.40']] },
    { day: 15, kind: 'receipt', merchant: 'Lyft', city: 'Chicago, IL', amount: '24.90', category: 'travel', costCentre: 'Sales', description: 'Hotel to the Merchandise Mart' },
  ] },
  { id: 'demo-claim-02', employee: 'trevor', title: 'Phone case and charger', created: 10, submitted: 9, decision: { by: 'dana', day: 8, decision: 'rejected', reason: 'Personal phone accessories are not covered; the company line ships with a charger.' }, expenses: [
    { day: 10, kind: 'receipt', merchant: 'Best Buy', city: 'Kansas City, MO', amount: '64.98', category: 'equipment', description: 'Rugged case and car charger' },
  ] },
  { id: 'demo-claim-03', employee: 'jordan', title: 'Denver client trip', created: 8, submitted: 7, submittedMinutes: 91, decision: { by: 'dana', day: 7, minutes: 134, decision: 'approved' }, batch: 'demo-batch-41', expenses: [
    { day: 8, kind: 'receipt', merchant: 'Blake Street Hotel', city: 'Denver, CO', amount: '412.80', category: 'lodging', costCentre: 'Client: Pikes Trail Supply', description: 'Two nights, one folio', lines: [['Room, 2 nights', '358.00'], ['Lodging and occupancy tax', '54.80']] },
    { day: 8, kind: 'receipt', merchant: 'MCI Economy Parking', city: 'Kansas City, MO', amount: '36.00', category: 'car', costCentre: 'Client: Pikes Trail Supply', description: 'Three days', lines: [['Economy lot, 3 days', '36.00']] },
  ] },
  { id: 'demo-claim-04', employee: 'trevor', title: 'Sioux Falls dealer visit', created: 7, submitted: 3, expenses: [
    { day: 7, kind: 'receipt', merchant: 'Casey’s', city: 'Sioux Falls, SD', amount: '58.40', category: 'meals', costCentre: 'Sales', description: 'Lunch with the Dakota Trail Outfitters team', lines: [['Large pizzas x3', '47.97'], ['Drinks', '6.50'], ['Sales tax', '3.93']] },
    { day: 7, kind: 'mileage', merchant: 'Kansas City to Sioux Falls and back', miles: '704', category: 'car', costCentre: 'Sales' },
  ] },
  { id: 'demo-claim-05', employee: 'cara', title: 'San Francisco buyer meeting', created: 6, submitted: 5, decision: { by: 'dana', day: 4, decision: 'approved' }, batch: 'demo-batch-42', expenses: [
    { day: 6, kind: 'receipt', merchant: 'Uber', city: 'San Francisco, CA', amount: '27.15', category: 'travel', costCentre: 'Sales', description: 'SFO to the REI buying office' },
    { day: 6, kind: 'receipt', merchant: 'Tartine Manufactory', city: 'San Francisco, CA', amount: '48.20', category: 'meals', costCentre: 'Sales', description: 'Lunch with two REI buyers', lines: [['Lunch for three', '43.80'], ['Sales tax', '4.40']] },
  ] },
  { id: 'demo-claim-06', employee: 'ben', title: 'Atlanta outdoor retailer show', created: 5, submitted: 4, decision: { by: 'dana', day: 2, decision: 'approved' }, expenses: [
    { day: 5, kind: 'receipt', merchant: 'Delta', city: 'Atlanta, GA', amount: '412.60', category: 'travel', costCentre: 'Sales', description: 'MCI to ATL and back', lines: [['DL 1422 MCI-ATL', '206.30'], ['DL 2091 ATL-MCI', '206.30']] },
    { day: 4, kind: 'per_diem', merchant: 'Atlanta, GA', days: 2, category: 'travel', costCentre: 'Sales' },
  ] },
  { id: 'demo-claim-07', employee: 'alyssa', title: 'Omaha dealer visits', created: 5, submitted: 4, decision: { by: 'dana', day: 3, decision: 'returned', reason: 'Attach the Hampton Inn folio; lodging always needs a receipt.' }, expenses: [
    { day: 5, kind: 'receipt', merchant: 'Hampton Inn Omaha', city: 'Omaha, NE', amount: '241.36', category: 'lodging', costCentre: 'Sales', description: 'One night', noReceipt: true, explanation: 'The front desk is emailing the folio; I will attach it when it arrives.' },
    { day: 5, kind: 'mileage', merchant: 'Kansas City to Omaha and back', miles: '372', category: 'car', costCentre: 'Sales' },
  ] },
  { id: 'demo-claim-08', employee: 'diego', title: 'Boulder store visit', created: 5, submitted: 4, decision: { by: 'dana', day: 3, decision: 'approved' }, batch: 'demo-batch-42', expenses: [
    { day: 5, kind: 'receipt', merchant: 'REI', city: 'Boulder, CO', amount: '112.45', category: 'equipment', costCentre: 'Sales', description: 'Rope and carabiners for the store fixture', lines: [['Static rope, 30 m', '64.95'], ['Carabiners x6', '38.94'], ['Sales tax', '8.56']] },
    { day: 5, kind: 'receipt', merchant: 'Pearl Street parking', city: 'Boulder, CO', amount: '12.00', category: 'car', costCentre: 'Sales' },
  ] },
  { id: 'demo-claim-09', employee: 'nina', title: 'Showroom display hardware', created: 5, submitted: 5, decision: { by: 'owner', day: 4, decision: 'approved' }, expenses: [
    { day: 6, kind: 'receipt', merchant: 'Home Depot', city: 'Kansas City, MO', amount: '89.23', category: 'office', costCentre: 'Marketing', description: 'Pegboard hooks and cable ties', lines: [['Pegboard hooks, 50 pack', '54.97'], ['Cable ties', '27.48'], ['Sales tax', '6.78']] },
  ] },
  { id: 'demo-claim-10', employee: 'kevin', title: 'Warehouse shelving repair', created: 4, submitted: 2, expenses: [
    { day: 4, kind: 'receipt', merchant: 'Home Depot', city: 'Lenexa, KS', amount: '146.88', category: 'equipment', costCentre: 'Warehouse', description: 'Brackets and lag screws for aisle 4', lines: [['Steel shelf brackets x12', '97.08'], ['Lag screws, 50 pack', '38.42'], ['Sales tax', '11.38']] },
  ] },
  { id: 'demo-claim-11', employee: 'owner', title: 'Kansas City lender lunch', created: 4, submitted: 3, expenses: [
    { day: 4, kind: 'receipt', merchant: 'Jack Stack Barbecue', city: 'Kansas City, MO', amount: '96.40', category: 'meals', costCentre: 'Operations', description: 'Lunch for three', explanation: 'Lunch with two from First Bank about the credit line; agreed with Dana.', lines: [['Lunch for three', '79.50'], ['Sales tax', '7.40'], ['Tip', '9.50']] },
  ] },
  { id: 'demo-claim-12', employee: 'ruth', title: 'October office supplies', created: 3, submitted: 3, decision: { by: 'owner', day: 2, decision: 'approved' }, expenses: [
    { day: 3, kind: 'receipt', merchant: 'Staples', city: 'Overland Park, KS', amount: '64.12', category: 'office', costCentre: 'Operations', description: 'Toner and receipt paper', lines: [['Toner cartridge', '49.99'], ['Thermal receipt paper', '9.29'], ['Sales tax', '4.84']] },
  ] },
  { id: 'demo-claim-13', employee: 'dana', title: 'Wichita dealer dinner', created: 3, submitted: 3, expenses: [
    { day: 3, kind: 'receipt', merchant: 'The Monarch', city: 'Wichita, KS', amount: '182.50', category: 'meals', costCentre: 'Sales', description: 'Dinner for five', explanation: 'Dinner with three Prairie Outfitters buyers and Ben; they signed the spring order.', lines: [['Dinner for five', '146.00'], ['Sales tax', '11.30'], ['Tip', '25.20']] },
  ] },
  { id: 'demo-claim-14', employee: 'owner', title: 'Overland Park trade show', created: 2, expenses: [
    { day: 2, kind: 'receipt', merchant: 'Hy-Vee', city: 'Overland Park, KS', amount: '34.20', category: 'meals', costCentre: 'Marketing', description: 'Booth snacks and water' },
    { day: 2, kind: 'receipt', merchant: 'Overland Park Convention Center', city: 'Overland Park, KS', amount: '15.00', category: 'car', costCentre: 'Marketing', description: 'Exhibitor parking' },
  ] },
];

/** `minutes` moves a batch's same-day steps later than 8:00 AM, after the approvals it holds. */
export type DemoBatch = { id: string; number: number; createdBy: Person; created: number; minutes?: number; reviewedBy?: Person; reviewed?: number; exported?: number; paid?: { by: Person; day: number; reference: string } };
export const batches: DemoBatch[] = [
  { id: 'demo-batch-41', number: 41, createdBy: 'owner', created: 7, minutes: 300, reviewedBy: 'ruth', reviewed: 7, exported: 7, paid: { by: 'ruth', day: 2, reference: 'ACH 1016-0041' } },
  { id: 'demo-batch-42', number: 42, createdBy: 'ruth', created: 2, minutes: 120 },
];

/** An agent working for the owner has turned three forwarded Lyft receipts into a claim for them to accept. */
export const proposal = {
  id: 'demo-proposal-1', key: 'demo-agent-key-1', agent: 'Receipt inbox agent', created: 2,
  title: 'Lyft rides to the Lenexa warehouse', note: 'From three Lyft receipts forwarded to the receipts inbox this week.',
  items: [
    { day: 5, merchant: 'Lyft', amount: '18.40', category: 'travel', description: 'Office to the Lenexa warehouse' },
    { day: 4, merchant: 'Lyft', amount: '21.75', category: 'travel', description: 'Lenexa warehouse to the office' },
    { day: 3, merchant: 'Lyft', amount: '19.60', category: 'travel', description: 'Office to the Lenexa warehouse' },
  ],
};
