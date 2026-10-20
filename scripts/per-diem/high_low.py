"""Normalize each complete official IRS notice, including every locality and season."""
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date

from bs4 import BeautifulSoup

from common import DAY, cents, clean, days, fetch, in_season, provenance, row

SEASON = re.compile(r'([A-Za-z]+ \d{1,2})\s*[–−-]\s*([A-Za-z]+ \d{1,2})')


def acquire(notices, meals, refresh=False):
    output, sources = [], []
    ordered = sorted(notices.items())
    with ThreadPoolExecutor(max_workers=4) as executor:
        documents = list(executor.map(lambda entry: fetch(entry[1], refresh=refresh), ordered))
    for (fy, url), data in zip(ordered, documents):
        soup = BeautifulSoup(data, 'html.parser')
        table = next(t for t in soup.select('table') if 'Portion of Calendar Year' in t.get_text())
        text = clean(soup.get_text(' ', strip=True))
        rates = re.search(r'are \$(\d+) for travel to any high-cost locality and \$(\d+) for travel to any other locality within CONUS', text)
        amounts = re.search(r'treated as paid for meals.*?is \$(\d+) for travel to any high-cost locality and \$(\d+) for travel to any other locality within CONUS', text)
        assert rates and amounts, f'IRS rate language changed: {url}'
        totals, mies = list(map(cents, rates.groups())), list(map(cents, amounts.groups()))
        start, end = date(fy - 1, 10, 1), date(fy, 9, 30)
        localities, state = [], ''
        for tr in table.select('tr'):
            cells = [clean(td.get_text(' ', strip=True)) for td in tr.select('td')]
            if len(cells) == 1:
                state = cells[0]
            elif len(cells) == 3:
                assert state, cells
                city, county, season = cells
                intervals = SEASON.findall(season)
                assert intervals and clean(SEASON.sub('', season)).replace('and', '').replace(',', '').strip() == '', season
                localities.append((state, city, county, intervals, season))
        assert len(localities) >= 75, f'Incomplete IRS table: {url}'
        output.append(normalize('', 'Other CONUS localities', 'All CONUS localities not high-cost for the travel date', start, end, 1, totals, mies, meals, url))
        for state, city, county, seasons, season_text in localities:
            last_kind, first = None, start
            for day in days(start, end):
                kind = 0 if any(in_season(day, a, b) for a, b in seasons) else 1
                if last_kind is not None and kind != last_kind:
                    output.append(normalize(state, city, county, first, day - DAY, last_kind, totals, mies, meals, url, season_text))
                    first = day
                last_kind = kind
            output.append(normalize(state, city, county, first, end, last_kind, totals, mies, meals, url, season_text))
        sources.append(provenance(url, data, fiscalYear=fy, localities=len(localities),
                                  highTotal=totals[0], lowTotal=totals[1], highMie=mies[0], lowMie=mies[1]))
    return output, sources


def normalize(state, city, county, begin, end, kind, totals, mies, meals, url, season=''):
    return row('high-low', 'US', state, city, county, begin, end,
               [totals[kind] - mies[kind]] * 12, mies[kind], meals, url,
               highCost=(kind == 0), highCostSeason=season)
