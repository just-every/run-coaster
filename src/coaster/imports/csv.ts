import { requireThat } from '../types';
import { parseCsv as readCsv } from './csv-parser.mjs';

/** The same CSV grammar is used by native imports and staged statement validation. */
export const parseCsv = (raw: string) => readCsv(raw, requireThat);
