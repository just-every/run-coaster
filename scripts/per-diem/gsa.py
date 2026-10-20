"""Read every locality and lodging season from official GSA fiscal workbooks."""
from collections import defaultdict
from datetime import date
from io import BytesIO
from urllib.parse import urljoin

import openpyxl
from bs4 import BeautifulSoup

from common import clean, cents, days, fetch, in_season, provenance, row

FILES_URL = 'https://www.gsa.gov/travel/plan-a-trip/per-diem-rates/per-diem-files'


def acquire(fiscal_years, meals, refresh=False):
    page = BeautifulSoup(fetch(FILES_URL, refresh=refresh), 'html.parser')
    output, sources = [], []
    for fy in fiscal_years:
        anchor = next((a for a in page.select('a[href]')
                       if f'FY {str(fy)[-2:]} Per Diem Rates' in a.get_text(' ', strip=True)
                       and '.xlsx' in a['href'].lower()), None)
        assert anchor, f'GSA has not published the FY{fy} XLSX link'
        url = urljoin(FILES_URL, anchor['href'])
        data = fetch(url, refresh=refresh)
        sheet = openpyxl.load_workbook(BytesIO(data), data_only=True).active
        values = list(sheet.values)
        header_index = next(i for i, values in enumerate(values) if 'STATE' in values and 'DESTINATION' in values)
        headers = list(values[header_index])
        positions = [headers.index(name) for name in ('STATE', 'DESTINATION', 'COUNTY/LOCATION DEFINED', 'SEASON BEGIN', 'SEASON END')]
        lodging_col = next(i for i, name in enumerate(headers) if name and 'Lodging' in name)
        mie_col = next(i for i, name in enumerate(headers) if name and 'M&IE' in name)
        grouped = defaultdict(list)
        for values in values[header_index + 1:]:
            if not isinstance(values[lodging_col], (int, float)):
                continue
            state, city, county, begin, end = [clean(values[i]) for i in positions]
            if not state:
                assert city.startswith('Standard CONUS rate'), city
                city, county = 'Standard CONUS', 'All locations not specifically listed by GSA'
            assert city and (len(state) == 2 or not state)
            grouped[(state, city, county)].append((begin or 'October 1', end or 'September 30', cents(values[lodging_col]), cents(values[mie_col])))
        start, end = date(fy - 1, 10, 1), date(fy, 9, 30)
        for (state, city, county), seasons in sorted(grouped.items()):
            lodging, mie = [None] * 12, set()
            for day in days(start, end):
                matches = [s for s in seasons if in_season(day, s[0], s[1])]
                assert len(matches) == 1, (fy, state, city, day, matches)
                _, _, price, meal = matches[0]
                assert lodging[day.month - 1] in (None, price), (city, day, 'non-monthly lodging')
                lodging[day.month - 1] = price
                mie.add(meal)
            assert len(mie) == 1 and all(x is not None for x in lodging)
            output.append(row('gsa', 'US', state, city, county, start, end, lodging, mie.pop(), meals, url))
        sources.append(provenance(url, data, fiscalYear=fy, localities=len(grouped), sourceRows=sum(map(len, grouped.values()))))
    return output, sources
