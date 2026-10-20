import { useEffect, useState } from 'react';
import { call, day, money, type D } from './api';
import { Choice, Field } from './parts';

const MEALS = ['breakfast', 'lunch', 'dinner'];
export function perDiemInput(config: D, values: D) {
  return { ...config, providedMeals: Object.keys(values).filter(k => k.startsWith('meal:') && values[k]).reduce((rows: D[], key) => {
    const [, date, meal] = key.split(':');
    let row = rows.find(r => r.date === date);
    if (!row) { row = { date, meals: [] }; rows.push(row); }
    row.meals.push(meal); return rows;
  }, []) };
}

/** Existing expense-form controls, with an explicit company alternative to published government rates. */
export function PerDiemFields({ date, config, onChange, companyRate, currency, fxEnabled, item }: { date: string; config: D; onChange: (v: D) => void; companyRate: number; currency: string; fxEnabled: boolean; item?: D }) {
  const [locations, setLocations] = useState<D[]>([]), [search, setSearch] = useState(''), [error, setError] = useState(''), [quote, setQuote] = useState<D>();
  useEffect(() => {
    let current = true; setLocations([]); setError(''); setQuote(undefined);
    if (config.method !== 'company') call(`per-diem/locations?method=${encodeURIComponent(config.method)}`).then(r => { if (current) setLocations(r.locations); }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [config.method]);
  useEffect(() => setQuote(undefined), [date, config]);
  const change = (v: D) => onChange({ ...config, ...v });
  const count = (Date.parse(config.endDate) - Date.parse(date)) / 86_400_000 + 1;
  const days = Number.isInteger(count) && count > 0 && count <= 60 ? Array.from({ length: count }, (_, i) => new Date(Date.parse(date) + i * 86_400_000).toISOString().slice(0, 10)) : [];
  const selected = locations.find(l => l.id === config.locationId);
  return <>
    <Choice label="Per diem method" name="perDiemMethod" value={config.method} onChange={(e: any) => { change({ method: e.target.value, locationId: '' }); setSearch(''); }}>
      <option value="gsa">GSA · continental United States</option><option value="state">State Department · foreign locations</option><option value="high-low">IRS high-low · continental United States</option>
      {companyRate > 0 && <option value="company">Company flat daily rate</option>}
    </Choice>
    {config.method === 'company' ? <>
      <Field label="Location" name="merchant" required={false} defaultValue={item?.kind === 'per_diem' ? item.merchant : ''} />
      <Field label="Days" name="days" type="number" min="1" max="60" defaultValue={item?.days ?? ''} />
      <p className="muted field-wide">Company rate: {money(companyRate, currency)} per claimed day, without government travel-day or meal adjustments.</p>
    </> : <>
      <Field label="Travel end date" name="perDiemEnd" type="date" value={config.endDate} onChange={(e: any) => change({ endDate: e.target.value })} />
      <Field label="Find per diem location" name="perDiemSearch" required={false} value={search} onChange={(e: any) => setSearch(e.target.value)} hint="Search the published city, county, state or country. Choose the exact published locality; Standard Rate is only for places without a listed rate." />
      <Choice label="Published location" name="perDiemLocation" required value={config.locationId} onChange={(e: any) => change({ locationId: e.target.value })}>
        <option value="">Choose…</option>
        {selected && !selected.label.toLowerCase().includes(search.toLowerCase()) && <option value={selected.id}>{selected.label}</option>}
        {locations.filter(l => l.label.toLowerCase().includes(search.toLowerCase())).map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
      </Choice>
      <Choice label="Per diem covers" name="perDiemComponent" value={config.component} onChange={(e: any) => change({ component: e.target.value })}><option value="mie">Meals and incidental expenses</option><option value="lodging">Lodging nights</option><option value="both">Meals and lodging</option></Choice>
      {currency !== 'USD' && <Field label="Exchange rate (optional)" name="manualRate" inputMode="decimal" required={false} pattern="[0-9]+(\.[0-9]{1,12})?" defaultValue={item?.fx_source === 'rate entered by hand' ? item.fx_rate : ''} hint={`1 USD in ${currency}. ${fxEnabled ? 'Leave empty for the enabled ECB reference rate, not a card rate.' : 'ECB is off; enter a rate by hand.'} The approver sees the rate and source.`} />}
      <p className="muted field-wide">Published rates are in USD. Meals are 75% on the first and last travel day, reduced once for a one-day trip. Full provided-meal amounts are deducted after that reduction, keeping incidentals. Lodging covers each night before the return date. This calculates an allowance; it does not certify tax treatment.</p>
      {config.component !== 'lodging' && days.length > 0 && <fieldset className="field-wide"><legend>Provided meals</legend><p className="muted">Mark meals furnished by the business or included in a registration fee. Leave complimentary hotel and common-carrier meals unmarked.</p>{days.map(date => <div key={date}><p>{day(date)}</p>{MEALS.map(meal => <Field key={meal} label={`${meal[0].toUpperCase() + meal.slice(1)} ${date}`} name={`meal:${date}:${meal}`} type="checkbox" required={false} defaultValue={item?.per_diem?.days.find((d: D) => d.date === date)?.providedMeals.includes(meal)} onChange={() => setQuote(undefined)} />)}</div>)}</fieldset>}
      <button className="button field-wide" type="button" onClick={async e => {
        setError(''); setQuote(undefined);
        try {
          const values = Object.fromEntries(new FormData(e.currentTarget.form!));
          setQuote(await call('per-diem/quote', { date, perDiem: perDiemInput(config, values) }));
        } catch (err) { setError((err as Error).message); }
      }}>Calculate per diem</button>
      {quote && <div className="field-wide" role="status"><strong>Per diem allowance: {money(quote.totalMinor, 'USD')}</strong><PerDiemBreakdown trip={quote} /></div>}
    </>}
    {error && <p className="form-error field-wide" role="alert">{error}</p>}
  </>;
}

export function PerDiemBreakdown({ trip }: { trip: D }) {
  return <details><summary>Daily rates and provided meals</summary><p>{trip.location} · {trip.method} · USD</p><ul className="ruled-list">{trip.days.map((d: D) => <li key={d.date}>
    <span>{day(d.date)} · FY{d.fiscalYear}: M&amp;IE {money(d.mieRateMinor)} × {d.travelPercent}% − {money(d.deductionMinor)} ({d.providedMeals.join(', ') || 'no provided meals'}) = {money(d.mieMinor)}; lodging {money(d.lodgingMinor)} at {money(d.lodgingRateMinor)} a night.</span>
    <p className="muted">Rate effective {d.effectiveFrom} through {d.effectiveTo}. <a href={d.source} target="_blank" rel="noreferrer">Official rate source</a></p>
  </li>)}</ul></details>;
}
