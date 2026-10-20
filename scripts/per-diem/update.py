#!/usr/bin/env python3
"""CLAIM-002: rebuild official USD per-diem data; failures leave the previous generated dataset intact."""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import gsa
import high_low
import state
from common import ROOT, meal_tables, write_json

NOTICES = {
    2025: 'https://www.irs.gov/irb/2024-41_IRB',
    2026: 'https://www.irs.gov/irb/2025-41_IRB',
    2027: 'https://www.irs.gov/irb/2026-43_irb',
}


def validate(rows):
    grouped = defaultdict(list)
    for value in rows:
        assert len(value['lodging']) == 12
        assert all(isinstance(n, int) and n >= 0 for n in value['lodging'])
        assert value['mie'] == sum(value[k] for k in ('breakfast', 'lunch', 'dinner', 'incidentals'))
        assert value['effectiveFrom'] <= value['effectiveTo']
        grouped[value['id']].append(value)
    for identity, values in grouped.items():
        for previous, current in zip(values, values[1:]):
            assert previous['effectiveTo'] < current['effectiveFrom'], ('Overlapping rate intervals', identity, previous, current)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--as-of', required=True, type=date.fromisoformat, help='Last State publication month to acquire (YYYY-MM-DD).')
    parser.add_argument('--fiscal-years', nargs='+', type=int, default=[2025, 2026, 2027])
    parser.add_argument('--irs-notice', action='append', default=[], metavar='FY=OFFICIAL_URL', help='Official IRS bulletin for a newly published fiscal year.')
    parser.add_argument('--refresh', action='store_true', help='Re-acquire all source bytes rather than using the download cache.')
    args = parser.parse_args()
    notices = dict(NOTICES)
    for entry in args.irs_notice:
        fy, url = entry.split('=', 1)
        assert url.startswith('https://www.irs.gov/irb/'), 'Use the official IRS bulletin HTML URL'
        notices[int(fy)] = url
    notices = {fy: notices[fy] for fy in args.fiscal_years}
    tables, meals_source = meal_tables(args.refresh)
    with ThreadPoolExecutor(max_workers=3) as executor:
        jobs = [executor.submit(gsa.acquire, args.fiscal_years, tables[0], args.refresh),
                executor.submit(high_low.acquire, notices, tables[0], args.refresh),
                executor.submit(state.acquire, date(min(args.fiscal_years) - 1, 10, 1), args.as_of, tables[1], args.refresh)]
        results = [job.result() for job in jobs]
    rows = sorted([r for values, _ in results for r in values], key=lambda r: (r['id'], r['effectiveFrom']))
    validate(rows)
    directory = ROOT / 'src/coaster/per-diem-data'
    directory.mkdir(exist_ok=True)
    manifest = dict(asOf=args.as_of.isoformat(), currency='USD', amountUnit='integer cents', lodgingMonths='January through December',
                    coverage={'gsaFiscalYears': sorted(args.fiscal_years), 'irsHighLowFiscalYears': sorted(notices),
                              'stateFrom': f'{min(args.fiscal_years) - 1}-10-01',
                              'stateThrough': max(r['effectiveTo'] for r in rows if r['method'] == 'state')},
                    records=dict(Counter(r['method'] for r in rows)),
                    sources=[meals_source] + [s for _, sources in results for s in sources])
    write_json(directory / 'rates.json', rows)
    write_json(directory / 'sources.json', manifest)
    print(f'CLAIM-002 validated and wrote {len(rows)} effective intervals: {manifest["records"]}')


if __name__ == '__main__':
    main()
