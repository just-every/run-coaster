import { test } from 'node:test';
import { companyPlaidJourney, personalPlaidJourney } from './plaid-native.mjs';

test('Plaid company connections enforce native authority, single-use consent, sealed custody and immutable history', companyPlaidJourney);
test('Plaid personal connections isolate custody and enforce atomic cost caps while manual claims remain available', personalPlaidJourney);

import { companyTransactionJourney, personalTransactionJourney } from './plaid-sync.mjs';
test('Plaid cursor sync creates posted company expenses once, excludes imported history and attaches only opted-in posted receipts', companyTransactionJourney);
test('Personal Plaid purchases reimburse once and retain financial evidence after same-transaction erasure of connection custody', personalTransactionJourney);
import { monthlyPlaidJourney } from './plaid-sync.mjs';
test('Connected Plaid account months accrue once, owner caps preserve manual claims and disconnection fences in-flight sync', monthlyPlaidJourney);
