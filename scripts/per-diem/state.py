"""Acquire complete monthly State DSSR925 publications through the as-of month."""
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from common import DAY, cents, clean, days, fetch, in_season, month_after, provenance, row

URL = 'https://allowances.state.gov/Web920/per_diem_action.asp'


def publication(day, refresh):
    form = {'CountryCode': '0000', 'PublicationDate': day.strftime('%Y%m%d'), 'MenuHide': '1'}
    data = fetch(URL, form, refresh=refresh)
    soup = BeautifulSoup(data, 'html.parser')
    selected = soup.select_one('select[name="PublicationDate"] option[selected]')
    assert selected and selected['value'] == form['PublicationDate'], f'State did not publish {day}'
    table = next(t for t in soup.select('table') if 'Country Name' in t.get_text()
                 and len(t.select('table')) == 0)
    parsed = []
    for tr in table.select('tr'):
        cells = tr.find_all('td', recursive=False)
        if len(cells) != 9:
            continue
        fields = [clean(c.get_text(' ', strip=True)) for c in cells]
        country, city, begin, end, lodging, mie, total, footnote, effective = fields
        lodging, mie, total = map(cents, (lodging, mie, total))
        assert country and city and total == lodging + mie, fields
        effective = date(*map(int, [effective[-4:], effective[:2], effective[3:5]]))
        assert effective <= day, fields
        link = cells[7].find('a', href=True)
        note = urljoin(URL, link['href']) if link else ''
        parsed.append((country, city, begin, end, lodging, mie, effective.isoformat(), note))
    assert len(parsed) >= 900, f'Incomplete State publication {day}: {len(parsed)} rows'
    return day, parsed, provenance(URL, data, requestMethod='POST', form=form,
                                    publicationDate=day.isoformat(), sourceRows=len(parsed),
                                    countries=len({r[0] for r in parsed}))


def acquire(start, as_of, meals, refresh=False):
    months, current = [], start.replace(day=1)
    while current <= as_of:
        months.append(current)
        current = month_after(current)
    with ThreadPoolExecutor(max_workers=5) as executor:
        publications = list(executor.map(lambda day: publication(day, refresh), months))
    output, sources = [], []
    for begin, records, evidence in publications:
        end = month_after(begin) - DAY
        sources.append(evidence)
        grouped = defaultdict(list)
        for record in records:
            grouped[record[:2]].append(record)
        for (country, city), seasons in sorted(grouped.items()):
            previous, first = None, None
            for day in days(begin, end):
                candidates = [r for r in seasons if in_season(day, r[2], r[3])]
                assert len(candidates) == 1, (begin, country, city, day, candidates)
                chosen = candidates[0]
                if chosen != previous:
                    if previous is not None:
                        output.append(normalize(previous, first, day - DAY, meals))
                    first, previous = day, chosen
            output.append(normalize(previous, first, end, meals))
    # Merge only identical adjacent official values, preserving each source effective date/note.
    merged = []
    for item in sorted(output, key=lambda r: (r['id'], r['effectiveFrom'])):
        same = merged and all(item[k] == merged[-1][k] for k in item if k not in ('effectiveFrom', 'effectiveTo'))
        adjacent = merged and date.fromisoformat(merged[-1]['effectiveTo']) + DAY == date.fromisoformat(item['effectiveFrom'])
        if same and adjacent:
            merged[-1]['effectiveTo'] = item['effectiveTo']
        else:
            merged.append(item)
    return merged, sources


def normalize(record, begin, end, meals):
    country, city, _, _, lodging, mie, source_effective, note = record
    return row('state', country, '', city, '', begin, end, [lodging] * 12, mie, meals, URL,
               sourceEffectiveFrom=source_effective, sourceFootnote=note)
