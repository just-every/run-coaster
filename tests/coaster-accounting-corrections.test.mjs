import { test } from 'node:test';
import { proveAccountingCorrections } from './accounting-corrections.mjs';

test('Native accounting corrections retain source evidence, batch selections and posting integrity', async () => {
  await proveAccountingCorrections();
});
