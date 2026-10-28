// The verify:app checks consume the exact build produced once by Verify's
// build job. Keep the hosted-output and hydration checks that rer verify adds.
import { spawnSync } from 'node:child_process'
import { resolveProject } from '@runeditrun/rer/internal/cli/project.mjs'
import { checkHostedOutput } from '@runeditrun/rer/internal/cli/hosted-output.mjs'
import { checkHydration } from '@runeditrun/rer/internal/cli/hydration/check.mjs'

for (const name of ['test:site', 'typecheck', 'test:typecheck', 'test:runtime', 'test:email-link']) {
  const result = spawnSync('pnpm', ['run', name], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
const project = await resolveProject(process.cwd())
const declaration = project.adapter.deployDeclaration ?? project.adapter.deploy?.declaration
console.log(await checkHostedOutput(project.root, { declaration }))
console.log(await checkHydration(project.root, {
  pages: project.adapter.publicPages, declaration,
  report: lines => lines.forEach(line => console.log(line)),
}))
