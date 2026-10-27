import { test } from 'node:test';
import { companyPlaidJourney, personalPlaidJourney } from './plaid-native.mjs';

test('Plaid company connections enforce native authority, single-use consent, sealed custody and immutable history', companyPlaidJourney);
test('Plaid personal connections isolate custody and enforce atomic cost caps while manual claims remain available', personalPlaidJourney);
