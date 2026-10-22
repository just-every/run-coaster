# Semantic coding corpus

This sibling corpus is frozen before evaluation. It leaves the original corpus
unchanged. The 120 cases retain its exact kind counts: finance 24, personal 12,
person 24, department 12, company 12, ambiguous 12, retired account 6, new MCC 6,
unknown 6 and retired class 6. There are 120 separately declared card charges,
120 actual receipt PNGs, and 120 observed human-coded expenses spanning twelve
months. No model has generated, selected or relabeled these expected answers.

- `catalog.json`: business, departments/people, ordered expense categories,
  class/project/account/customer choices, and values to retire after history.
- `rules.json`: native finance/personal merchant rules and MCC mappings.
- `history.json`: earlier native human expense inputs. These are observations,
  including obsolete bookkeeping that an exact current rule overrides.
- `charges.json`: native card-source input only; no expected coding.
- `labels.json`: expected coding and abstentions, in numeric category/class/
  project order from `catalog.json`; customer expectations use display names.
- `labels/*.json`: independently frozen printed receipt facts and expected
  coding, used for scoring and pixel generation, never uploaded as app data.
- `receipts/*.png`: receipt pixels, uploaded without typed merchant or answers.

The ambiguous cases alternate actual office goods and meals at Amazon and an
airport marketplace. Both have mixed prior coding and an unmapped miscellaneous
MCC. Two ordinary invoices have customer/project work references in printed
purchase descriptions and billing details; other source-five receipts supply
no class, project or customer evidence. Unknown counter purchases omit their
contents and purpose and require abstention. Design-service purchases retain
an archived usual account with no active replacement. Airport electronics
purchases retain an archived usual class; their active card MCC supplies only
the office category. Abstentions remain in full repeat denominators.

Run `freeze.mjs` only when deliberately defining a new pre-evaluation corpus.
`render.mjs` reads the frozen receipt facts and produces PNGs using a real
headless browser. It never calls a model or app. Render with the approved
heavy-slot wrapper, normal HOME, and current Playwright. Do not change labels
or composition after seeing live quality results. Preserve the evaluated
commit and image hashes in the quality evidence.
