import type { RunData } from '../base/run-site';

/** Every string and command on the run site's Run page (/run). */
export const run: RunData = {
  name: 'Coaster',
  repository: 'https://github.com/just-every/run-coaster',
  clone: 'git clone https://github.com/just-every/run-coaster.git coaster',
  folder: 'coaster',
  requirements: 'Needs Git and Node 22 or later, on macOS, Linux or Windows with WSL2. rer installs the pnpm and Node versions Coaster pins by itself.',
  licence: 'MIT',
  docs: true,
  hosted: [],
};
