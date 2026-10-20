"""Shared acquisition, provenance and USD normalization for official rate tables."""
import calendar
import hashlib
import json
import re
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(__file__).resolve().parent / '.cache'
BREAKDOWN_URL = 'https://www.gsa.gov/travel/plan-a-trip/per-diem-rates/mie-breakdowns'
DAY = timedelta(days=1)


def fetch(url, form=None, refresh=False):
    """Cache immutable request inputs; explicit refresh re-acquires the publisher bytes."""
    body = urlencode(form).encode() if form else None
    key = hashlib.sha256(url.encode() + (body or b'')).hexdigest()
    CACHE.mkdir(exist_ok=True)
    path = CACHE / key
    if refresh or not path.exists():
        request = Request(url, data=body, headers={'User-Agent': 'Coaster official-per-diem updater'})
        with urlopen(request, timeout=90) as response:
            data = response.read()
        path.write_bytes(data)
    return path.read_bytes()


def provenance(url, data, **fields):
    return dict(url=url, sha256=hashlib.sha256(data).hexdigest(), **fields)


def clean(value):
    return re.sub(r'\s+', ' ', str(value or '')).strip()


def cents(value):
    number = float(str(value).replace('$', '').replace(',', '').strip()) * 100
    assert number >= 0 and number.is_integer(), value
    return int(number)


def month_after(day):
    return date(day.year + (day.month == 12), day.month % 12 + 1, 1)


def days(start, end):
    while start <= end:
        yield start
        start += DAY


def md(value):
    text = clean(value)
    match = re.fullmatch(r'(\d\d)/(\d\d)', text)
    if match:
        return tuple(map(int, match.groups()))
    match = re.fullmatch(r'([A-Za-z]+) (\d{1,2})(?:, \d{4})?', text)
    assert match, text
    return list(calendar.month_name).index(match[1]), int(match[2])


def in_season(day, start, end):
    a, b, value = md(start), md(end), (day.month, day.day)
    return a <= value <= b if a <= b else value >= a or value <= b


def meal_tables(refresh=False):
    data = fetch(BREAKDOWN_URL, refresh=refresh)
    soup = BeautifulSoup(data, 'html.parser')
    tables = []
    for table in soup.select('table'):
        values = {}
        for row in table.select('tr'):
            cells = [clean(c.get_text(' ', strip=True)) for c in row.select('td')]
            if len(cells) >= 5 and re.fullmatch(r'\$?\d+', cells[0]):
                numbers = [cents(c) for c in cells[:5]]
                assert numbers[0] == sum(numbers[1:]), numbers
                values[numbers[0]] = numbers[1:]
        if values:
            tables.append(values)
    assert len(tables) == 2 and len(tables[0]) >= 5 and len(tables[1]) == 265
    return tables, provenance(BREAKDOWN_URL, data)


def meal_fields(mie, table, overseas=False):
    if mie in table:
        values = table[mie]
    else:
        assert overseas and mie > 26500, mie
        # GSA explicitly prescribes these percentages above the published table.
        values = [mie * n // 100 for n in (15, 25, 40)]
        values.append(mie - sum(values))
    return dict(mie=mie, **dict(zip(('breakfast', 'lunch', 'dinner', 'incidentals'), values)))


def row(method, country, state, city, county, start, end, lodging, mie, table, source, **extra):
    identity = ':'.join([method, country, state, city, county])
    return dict(id=identity, method=method, country=country, state=state, city=city, county=county,
                effectiveFrom=start.isoformat(), effectiveTo=end.isoformat(), lodging=lodging,
                **meal_fields(mie, table, method == 'state'), source=source, **extra)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
