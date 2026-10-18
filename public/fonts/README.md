# Fonts

Coaster's five faces are self-hosted under the SIL Open Font License 1.1, each licence (`LICENSE.txt`) beside its
files. The WOFF2 files come from Fontsource's distributions (variable where the family has one).

| Face | Used for | Files | Upstream |
| --- | --- | --- | --- |
| Archivo | headings (condensed to 80% width) and the "Coaster" wordmark | `archivo/` (Latin, Latin Extended, widths 62–125%, weights 100–900) | https://github.com/Omnibus-Type/Archivo |
| Inter | text | `inter/` (Latin, Latin Extended, weights 100–900) | https://github.com/rsms/inter |
| JetBrains Mono | code and the terminal | `jetbrains-mono/` (Latin, weights 100–800) | https://github.com/JetBrains/JetBrainsMono |
| Courier Prime | printed receipts in the homepage's drawings | `courier-prime/` (Latin, 400 and 700) | https://github.com/quoteunquoteapps/CourierPrime |
| Kalam | handwritten stickies in the homepage's drawings | `kalam/` (Latin, 400 and 700) | https://github.com/itfoundry/kalam |

`public/rer-theme.css` declares the faces once, so Base's own pages (sign-in, /setup, the Lobby, the Run page), the
app and the run site share them. `src/base/font-head.ts` preloads the Archivo and Inter Latin files. The page
makes no third-party request.
