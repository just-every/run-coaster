import { test } from 'node:test';
import { companyPlaidJourney } from './plaid-native.mjs'

test('Plaid company connections enforce native authority, single-use consent, sealed custody and immutable history', companyPlaidJourney);
