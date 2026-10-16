import type { RunData } from '../base/run-site';

/** Every string and command on the run site's Run page (/run). */
export const run: RunData = {
  name: 'Coaster',
  repository: 'https://github.com/just-every/run-coaster',
  clone: 'npx -y @runeditrun/rer dev just-every/run-coaster',
  folder: 'run-coaster',
  requirements: 'Runs on macOS, Linux or Windows with WSL2, with git. The installer brings Node when it is missing, and rer brings pnpm.',
  licence: 'MIT',
  docs: true,
  hosted: [],
};
