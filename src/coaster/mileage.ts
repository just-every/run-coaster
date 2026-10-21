import { commit } from './session';
import { needRow, rowAuthority } from './permissions';
import { event } from './events';
import { isoDate, rate, requireThat, type Actor, type Data } from './types';

export type MileageRate = { effective_from: string; rate_thousandths: number };

/** The IRS standard business mileage rates, in thousandths of a dollar a mile, from the day each took effect. */
export const IRS_MILEAGE_RATES: MileageRate[] = [
  { effective_from: '2022-01-01', rate_thousandths: 585 },
  { effective_from: '2022-07-01', rate_thousandths: 625 },
  { effective_from: '2023-01-01', rate_thousandths: 655 },
  { effective_from: '2024-01-01', rate_thousandths: 670 },
  { effective_from: '2025-01-01', rate_thousandths: 700 },
  { effective_from: '2026-01-01', rate_thousandths: 725 },
];

export async function mileageRates(db: D1Database): Promise<MileageRate[]> {
  return (await db.prepare('SELECT effective_from,rate_thousandths FROM c_mileage_rates ORDER BY effective_from').all<MileageRate>()).results;
}

/** The rate in force on a trip date: the latest one that took effect on or before it. */
export function rateOn(rates: MileageRate[], day: string) {
  return rates.filter(r => r.effective_from <= day).at(-1)?.rate_thousandths ?? null;
}

export const seedIrsRates = (db: D1Database) => IRS_MILEAGE_RATES.map(r => db.prepare('INSERT INTO c_mileage_rates(effective_from,rate_thousandths) VALUES(?,?) ON CONFLICT DO NOTHING').bind(r.effective_from, r.rate_thousandths));

/** The owner adds a rate from a date, changes one, or removes one; expenses already entered keep the rate copied onto them. */
export async function saveMileageRate(db: D1Database, actor: Actor, b: Data) {
  needRow(actor, 'settings');
  const from = isoDate(b.effectiveFrom, 'Effective from');
  if (b.remove === true || b.remove === 'true') {
    requireThat(await db.prepare('SELECT 1 FROM c_mileage_rates WHERE effective_from=?').bind(from).first(), 'No mileage rate takes effect on that date', 404);
    await commit(db, rowAuthority(actor, 'settings'), [db.prepare('DELETE FROM c_mileage_rates WHERE effective_from=?').bind(from), event(db, actor, 'mileage-rate-removed', {}, { effectiveFrom: from })]);
  } else {
    const thousandths = rate(b.rate, 'Mileage rate per mile');
    requireThat(thousandths > 0, 'Mileage rate per mile must be more than zero');
    await commit(db, rowAuthority(actor, 'settings'), [
      db.prepare('INSERT INTO c_mileage_rates(effective_from,rate_thousandths) VALUES(?,?) ON CONFLICT(effective_from) DO UPDATE SET rate_thousandths=excluded.rate_thousandths').bind(from, thousandths),
      event(db, actor, 'mileage-rate-saved', {}, { effectiveFrom: from, rateThousandths: thousandths }),
    ]);
  }
  return mileageRates(db);
}
