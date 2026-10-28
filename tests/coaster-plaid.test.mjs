import { test } from 'node:test';
import { companyPlaidJourney, personalPlaidJourney } from './plaid-native.mjs';

test('Plaid company connections enforce native authority, single-use consent, sealed custody and immutable history', companyPlaidJourney);
test('Plaid personal connections isolate custody and enforce atomic cost caps while manual claims remain available', personalPlaidJourney);

import { plaidCorrectionsJourney } from './plaid-corrections.mjs';
import { companyTransactionJourney, personalTransactionJourney } from './plaid-sync.mjs';
test('Plaid cursor sync creates posted company expenses once, excludes imported history and attaches only opted-in posted receipts', async()=>{await companyTransactionJourney();await plaidCorrectionsJourney();});
test('Personal Plaid purchases reimburse once and retain financial evidence after same-transaction erasure of connection custody', personalTransactionJourney);

import { personalCreditJourney } from './plaid-sync.mjs';
test('A later personal-card credit pauses payment of the original purchase without rewriting financial evidence or stopping manual claims', personalCreditJourney);

import { largePlaidJourney } from './plaid-large-sync.mjs';
test('A complete first month syncs across bounded financial batches, safely resumes interruption and fences revoked authority', largePlaidJourney);
