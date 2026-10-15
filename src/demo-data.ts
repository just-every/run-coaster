// Harbour & Finch Studio, the business Coaster's own tests set up (tests/harness.mjs),
// as it looks a few weeks into using Coaster. Days count back from the moment a demo starts;
// `owner` is whoever signs in to the demo.

export const business = { name: 'Harbour & Finch Studio', currency: 'AUD', timezone: 'Australia/Sydney', mileageRateMinor: 88, perDiemMinor: 7500, receiptThresholdMinor: 0 };
export const ownerName = 'Maya Finch';

export const categories = [
  { id: 'demo-cat-meals', name: 'Meals', account: '6300', tax: 'GST', limitMinor: 12000 },
  { id: 'demo-cat-travel', name: 'Travel', account: '6200', tax: 'GST', limitMinor: null },
  { id: 'demo-cat-car', name: 'Car', account: '6400', tax: 'GST Free', limitMinor: null },
  { id: 'demo-cat-office', name: 'Office supplies', account: '6500', tax: 'GST', limitMinor: null },
  { id: 'demo-cat-software', name: 'Software', account: '6550', tax: 'GST', limitMinor: 50000 },
  { id: 'demo-cat-training', name: 'Training', account: '6600', tax: 'GST', limitMinor: null },
];

export type Person = 'owner' | 'priya' | 'morgan' | 'sam' | 'lena' | 'tom' | 'alex' | 'jordan';
export const people: Record<Exclude<Person, 'owner'>, { email: string; name: string; employee: boolean; manager: boolean; finance: boolean; approver: Person | null; active: boolean }> = {
  priya: { email: 'priya@harbourfinch.example', name: 'Priya Raman', employee: true, manager: true, finance: false, approver: 'owner', active: true },
  morgan: { email: 'morgan@harbourfinch.example', name: 'Morgan Ellis', employee: true, manager: false, finance: true, approver: 'priya', active: true },
  sam: { email: 'sam@harbourfinch.example', name: 'Sam Okafor', employee: true, manager: false, finance: false, approver: 'priya', active: true },
  lena: { email: 'lena@harbourfinch.example', name: 'Lena Fischer', employee: true, manager: false, finance: false, approver: 'priya', active: true },
  tom: { email: 'tom@harbourfinch.example', name: 'Tom Becker', employee: true, manager: false, finance: false, approver: 'owner', active: true },
  alex: { email: 'alex@harbourfinch.example', name: 'Alex Tran', employee: true, manager: false, finance: false, approver: 'owner', active: true },
  jordan: { email: 'jordan@harbourfinch.example', name: 'Jordan Wu', employee: true, manager: false, finance: false, approver: 'priya', active: false },
};

type Category = 'meals' | 'travel' | 'car' | 'office' | 'software' | 'training';
/** One expense: a receipt (with its receipt file unless `noReceipt`), mileage in km, or per diem days. */
export type Expense = { day: number; category: Category; costCentre?: string; explanation?: string; description?: string; split?: [Category, string, string][] } & (
  | { kind: 'receipt'; merchant: string; amount: string; noReceipt?: boolean; lines?: [string, string][] }
  | { kind: 'mileage'; merchant: string; km: string }
  | { kind: 'per_diem'; merchant: string; days: number });

export type Decision = { by: Person; day: number; decision: 'approved' | 'returned' | 'rejected'; reason?: string };
export type DemoClaim = { id: string; employee: Person; title: string; created: number; expenses: Expense[]; submitted?: number; decision?: Decision; batch?: string };

export const claims: DemoClaim[] = [
  { id: 'demo-claim-01', employee: 'sam', title: 'Melbourne client pitch', created: 34, submitted: 31, decision: { by: 'priya', day: 30, decision: 'approved' }, batch: 'demo-batch-1', expenses: [
    { day: 36, kind: 'receipt', merchant: 'Qantas', amount: '289.00', category: 'travel', costCentre: 'Client: Lyra Health', description: 'SYD-MEL return', lines: [['QF 409 SYD-MEL', '144.50'], ['QF 432 MEL-SYD', '144.50']] },
    { day: 35, kind: 'receipt', merchant: 'Ovolo Laneways', amount: '412.00', category: 'travel', costCentre: 'Client: Lyra Health', description: 'Two nights', lines: [['Room, 2 nights', '398.00'], ['City tax', '14.00']] },
    { day: 35, kind: 'per_diem', merchant: 'Melbourne', days: 2, category: 'travel', costCentre: 'Client: Lyra Health' },
    { day: 34, kind: 'receipt', merchant: '13cabs', amount: '38.40', category: 'travel', costCentre: 'Client: Lyra Health', description: 'Hotel to client office' },
  ] },
  { id: 'demo-claim-02', employee: 'owner', title: 'Studio supplies for the brand workshop', created: 33, submitted: 32, decision: { by: 'priya', day: 31, decision: 'approved' }, batch: 'demo-batch-1', expenses: [
    { day: 33, kind: 'receipt', merchant: 'Officeworks', amount: '86.35', category: 'office', description: 'Butcher paper, markers, sticky notes', lines: [['Butcher paper roll', '24.95'], ['Markers 24pk', '32.40'], ['Sticky notes 12pk', '29.00']] },
    { day: 33, kind: 'receipt', merchant: 'Kmart', amount: '42.00', category: 'office', description: 'Display easels' },
  ] },
  { id: 'demo-claim-03', employee: 'lena', title: 'Design Week Sydney ticket', created: 30, submitted: 29, decision: { by: 'priya', day: 28, decision: 'approved' }, batch: 'demo-batch-1', expenses: [
    { day: 31, kind: 'receipt', merchant: 'Design Week Sydney', amount: '349.00', category: 'training', description: 'Two-day pass' },
    { day: 29, kind: 'receipt', merchant: 'Bills Surry Hills', amount: '31.50', category: 'meals', description: 'Lunch between sessions' },
  ] },
  { id: 'demo-claim-04', employee: 'tom', title: 'Newcastle client visits', created: 18, submitted: 16, decision: { by: 'owner', day: 15, decision: 'approved' }, batch: 'demo-batch-2', expenses: [
    { day: 20, kind: 'mileage', merchant: 'Studio to Newcastle and back', km: '324', category: 'car', costCentre: 'Client: Hunter Brewing' },
    { day: 20, kind: 'receipt', merchant: 'Secure Parking Newcastle', amount: '24.00', category: 'car', costCentre: 'Client: Hunter Brewing' },
    { day: 20, kind: 'receipt', merchant: 'Rustica', amount: '58.20', category: 'meals', costCentre: 'Client: Hunter Brewing', description: 'Lunch with the brand team' },
  ] },
  { id: 'demo-claim-05', employee: 'morgan', title: 'Xero payroll course', created: 17, submitted: 16, decision: { by: 'priya', day: 14, decision: 'approved' }, batch: 'demo-batch-2', expenses: [
    { day: 19, kind: 'receipt', merchant: 'Xero', amount: '195.00', category: 'training', description: 'Payroll advisor course' },
  ] },
  { id: 'demo-claim-06', employee: 'alex', title: 'Photo shoot props', created: 12, submitted: 11, decision: { by: 'owner', day: 9, decision: 'approved' }, expenses: [
    { day: 13, kind: 'receipt', merchant: 'Bunnings Warehouse', amount: '67.80', category: 'office', costCentre: 'Client: Saltwater Swim', description: 'Timber offcuts and clamps' },
    { day: 13, kind: 'receipt', merchant: 'Paddy’s Markets', amount: '45.00', category: 'office', costCentre: 'Client: Saltwater Swim', description: 'Fresh flowers for set', noReceipt: true, explanation: 'Cash stall with no receipts; photo of the stall sign in the shoot folder.' },
    { day: 12, kind: 'receipt', merchant: 'Uber', amount: '27.65', category: 'travel', costCentre: 'Client: Saltwater Swim' },
  ] },
  { id: 'demo-claim-07', employee: 'priya', title: 'Team offsite in the Blue Mountains', created: 10, submitted: 9, decision: { by: 'owner', day: 8, decision: 'approved', reason: 'Thanks for organising.' }, expenses: [
    { day: 11, kind: 'receipt', merchant: 'Hydro Majestic', amount: '540.00', category: 'meals', description: 'Team lunch for six', split: [['meals', 'Studio', '120.00'], ['training', 'Studio', '420.00']], explanation: 'Lunch was part of the paid workshop venue; split agreed with Morgan.', lines: [['Workshop room hire', '420.00'], ['Lunch, 6 guests', '120.00']] },
    { day: 11, kind: 'mileage', merchant: 'Studio to Katoomba and back', km: '212', category: 'car', costCentre: 'Studio' },
  ] },
  { id: 'demo-claim-08', employee: 'tom', title: 'Hunter Brewing launch dinner', created: 6, submitted: 4, expenses: [
    { day: 7, kind: 'receipt', merchant: 'Margan Restaurant', amount: '186.00', category: 'meals', costCentre: 'Client: Hunter Brewing', description: 'Dinner with client founders', explanation: 'Launch dinner for three; the client chose the venue.', lines: [['Tasting menu x3', '165.00'], ['Sparkling water', '21.00']] },
    { day: 7, kind: 'receipt', merchant: 'Hunter Valley Resort', amount: '219.00', category: 'travel', costCentre: 'Client: Hunter Brewing', description: 'One night' },
    { day: 7, kind: 'mileage', merchant: 'Studio to Pokolbin and back', km: '338', category: 'car', costCentre: 'Client: Hunter Brewing' },
  ] },
  { id: 'demo-claim-09', employee: 'owner', title: 'Studio software renewals', created: 5, submitted: 4, expenses: [
    { day: 6, kind: 'receipt', merchant: 'Figma', amount: '264.00', category: 'software', description: 'Professional plan, two editors' },
    { day: 6, kind: 'receipt', merchant: 'Adobe', amount: '89.99', category: 'software', description: 'Creative Cloud single app' },
  ] },
  { id: 'demo-claim-10', employee: 'priya', title: 'Client workshop catering', created: 4, submitted: 3, expenses: [
    { day: 5, kind: 'receipt', merchant: 'Harris Farm Markets', amount: '73.45', category: 'meals', costCentre: 'Client: Lyra Health', description: 'Fruit and pastries' },
    { day: 5, kind: 'receipt', merchant: 'Single O', amount: '48.00', category: 'meals', costCentre: 'Client: Lyra Health', description: 'Coffee for twelve' },
  ] },
  { id: 'demo-claim-11', employee: 'sam', title: 'Printing for the Saltwater pitch', created: 3, submitted: 2, expenses: [
    { day: 3, kind: 'receipt', merchant: 'Snap Printing Surry Hills', amount: '132.00', category: 'office', costCentre: 'Client: Saltwater Swim', description: 'A3 boards, matte' },
  ] },
  { id: 'demo-claim-12', employee: 'lena', title: 'Canberra site survey', created: 9, submitted: 7, decision: { by: 'priya', day: 6, decision: 'returned', reason: 'Please attach the parking receipt; the car park emails one.' }, expenses: [
    { day: 9, kind: 'mileage', merchant: 'Studio to Canberra and back', km: '572', category: 'car', costCentre: 'Client: National Arboretum' },
    { day: 9, kind: 'receipt', merchant: 'Wilson Parking Canberra', amount: '18.00', category: 'car', costCentre: 'Client: National Arboretum', noReceipt: true, explanation: 'Machine was out of paper.' },
  ] },
  { id: 'demo-claim-13', employee: 'alex', title: 'Gym membership', created: 8, submitted: 8, decision: { by: 'owner', day: 7, decision: 'rejected', reason: 'A personal membership is not a studio expense.' }, expenses: [
    { day: 8, kind: 'receipt', merchant: 'Fitness First', amount: '79.00', category: 'office', description: 'Monthly membership' },
  ] },
  { id: 'demo-claim-14', employee: 'owner', title: 'Sydney Design Awards dinner', created: 1, expenses: [
    { day: 2, kind: 'receipt', merchant: 'Ivy Ballroom', amount: '110.00', category: 'meals', description: 'Awards dinner ticket' },
    { day: 2, kind: 'receipt', merchant: 'Uber', amount: '34.20', category: 'travel', description: 'Home after the awards' },
  ] },
];

export type DemoBatch = { id: string; number: number; createdBy: Person; created: number; reviewedBy?: Person; reviewed?: number; exported?: number; paid?: { by: Person; day: number; reference: string } };
export const batches: DemoBatch[] = [
  { id: 'demo-batch-1', number: 1, createdBy: 'owner', created: 27, reviewedBy: 'morgan', reviewed: 26, exported: 26, paid: { by: 'morgan', day: 25, reference: 'CBA EFT 240918' } },
  { id: 'demo-batch-2', number: 2, createdBy: 'morgan', created: 13 },
];

/** An agent working for the owner has turned three emailed ride receipts into a claim for them to accept. */
export const proposal = {
  id: 'demo-proposal-1', key: 'demo-agent-key-1', agent: 'Receipt assistant', created: 1,
  title: 'Rides to client meetings', note: 'From three Uber receipts in your inbox this week.',
  items: [
    { day: 4, merchant: 'Uber', amount: '22.80', category: 'travel', description: 'Studio to Lyra Health' },
    { day: 3, merchant: 'Uber', amount: '19.35', category: 'travel', description: 'Lyra Health to studio' },
    { day: 2, merchant: 'Uber', amount: '31.10', category: 'travel', description: 'Studio to Saltwater Swim' },
  ],
};
