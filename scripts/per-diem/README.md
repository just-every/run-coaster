# Official per-diem source updater

This tool generates `src/coaster/per-diem-data/rates.json` and `sources.json` from complete official tables. It uses Python 3.9+ and the two packages in `requirements.txt`; no application dependency changes are required.

Run from the checkout root, with the dependencies installed in a Python environment:

```sh
python3 scripts/per-diem/update.py --as-of 2026-10-20
```

The arguments, downloaded publisher bytes and parser determine the output. The `.cache` directory keeps source responses keyed by URL and POST body. `--refresh` re-acquires every source; without it, existing source responses are reused. `sources.json` records a SHA-256 digest of every response, the source URL, effective coverage and the exact State request forms. Output contains no wall-clock generation time. The tool obtains all sources and validates every rate before replacing output.

For a newly published fiscal year, add that year and its official IRS bulletin URL:

```sh
python3 scripts/per-diem/update.py --as-of 2027-10-20 --fiscal-years 2025 2026 2027 2028 --irs-notice 2028=https://www.irs.gov/irb/REPLACE_WITH_PUBLISHED_BULLETIN --refresh
```

The example deliberately requires the actual newly published bulletin URL. GSA workbook URLs are discovered from its official per-diem-files page, so filename changes do not require code edits. An unpublished fiscal year, unrecognized source schema, missing month, invalid money amount, overlapping effective interval or incomplete locality table stops generation. No prior-year or guessed rate substitutes for an unavailable source.

`--as-of` selects the last State publication month, not a future annual rate. State publishes monthly, and the complete all-locations table requires **POST** to `https://allowances.state.gov/Web920/per_diem_action.asp`, with `CountryCode=0000`, `PublicationDate=YYYYMM01` and `MenuHide=1`. GET query parameters are ignored by that endpoint. The navigation's legacy `ExcelVersion.asp` redirects to the home page as of acquisition, so this tool parses the actual official HTML table. Source forms in `sources.json` allow every publication to be reproduced. Refresh monthly for State changes and each fiscal year for GSA/IRS; also refresh after publisher corrections.

## Schema and semantics

Every numeric amount is integer USD cents. `lodging` has twelve values in **January–December** order. `effectiveFrom` and `effectiveTo` are inclusive ISO calendar dates. `id` is the concatenation `method:country:state:city:county`, stable across fiscal years and rate changes. Official location strings are preserved after whitespace normalization; there is no inferred city/county mapping or geocoding.

- `gsa`: each official locality has one record per fiscal year, including Standard CONUS. Every workbook lodging season is checked day by day; monthly lodging is populated only when every day in that month has the same official amount. Each M&IE amount uses the exact CONUS component table published by GSA.
- `state`: every foreign locality in every monthly publication from the first requested fiscal year to the as-of month is acquired. Source seasons are applied day by day, including mid-month boundaries and changing seasonal M&IE. Consecutive identical records are merged. `sourceEffectiveFrom` preserves the rate effective date shown in the source, and `sourceFootnote` preserves an official footnote link when present. GSA's exact OCONUS component table is used through $265; above $265 the published 15%/25%/40% meal allocation and incidental remainder apply. Some official restricted localities have zero lodging; the source footnote remains relevant.
- `high-low`: every high-cost locality and season in the IRS notice is included, with explicit high and low effective intervals for the same locality. `highCost` identifies the interval's status; `highCostSeason` preserves the notice's complete season wording. The generic Other CONUS record is the published low rate. Lodging equals the IRS combined amount minus its M&IE component; meals use the matching GSA CONUS breakdown.

The dataset preserves rates; the application is responsible for selecting an explicit locality, enforcing trip-date coverage, applying travel-day and provided-meal rules, and retaining the chosen rate on the expense. State covers foreign areas. Alaska, Hawaii and US territories are administered by DoD and are not State foreign-rate records.

## Acquisition validation

Generation checks every GSA day for exactly one seasonal rate; every State day for exactly one seasonal rate per published locality; M&IE component sums; official lodging + M&IE totals; missing source months; and non-overlapping intervals for each stable id. The generated `sources.json` contains source row and locality counts for review. No network or parser error is converted into application rate data.
