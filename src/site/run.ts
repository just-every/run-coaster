import type { RunData } from '../base/run-site';
import { runPricing } from '../base/run-pricing';

/** Every string and command on the run site's Run page (/run). */
export const run: RunData = {
  name: 'Coaster',
  repository: 'https://github.com/just-every/run-coaster',
  clone: 'npx -y @runeditrun/rer dev just-every/run-coaster',
  licence: 'MIT',
  docs: true,
  paths: { product: null },
  pricing: runPricing,
};
