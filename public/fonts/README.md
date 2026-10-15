# Fonts

Newsreader (headings) and Instrument Sans (everything else) are self-hosted
under the SIL Open Font License 1.1, each licence beside its files. The Latin
and Latin Extended WOFF2 subsets come from Fontsource's variable distributions;
upstreams: https://github.com/productiontype/Newsreader and
https://github.com/Instrument/instrument-sans.

`public/rer-theme.css` declares the faces once, so Base's own pages (sign-in,
/setup, the Lobby, the Run page) and the app share them. `src/base/font-head.ts`
preloads the two Latin files. The page makes no third-party request.
