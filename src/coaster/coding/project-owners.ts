import { requireThat, type Data } from '../types';
import { catalogState, codingCatalog, offeredValue } from './model';

/** A native catalog project has a persisted owner, never an inferred person from the project name.
 * Resolve all distinct project owners in parallel and freeze them into the submitted plan. */
export async function projectOwners(db: D1Database, items: Data[]) {
  const catalog = await codingCatalog(db), projects = new Set<string>();
  for (const item of items) {
    const selected = (item.codingSnapshot ?? []).filter((v: Data) => v.kind === 'project');
    if (selected.length) selected.forEach((v: Data) => projects.add(v.id));
    else if (item.project) {
      const candidates = catalog.values.filter(v => v.name === item.project && catalog.dimensions.some(d => d.id === v.dimension_id && d.kind === 'project') && offeredValue(catalog,v));
      requireThat(candidates.length === 1, `Choose a catalog project with an owner for ${item.project}`,409);
      projects.add(candidates[0].id);
    }
  }
  requireThat(projects.size > 0, 'A project-owner workflow needs a catalog project on the expense',409);
  const owners: string[] = [];
  for (const id of projects) {
    const project = catalog.values.find(v => v.id === id);
    requireThat(project && offeredValue(catalog,project) && project.owner_email, 'Every project in this workflow needs an active project owner',409);
    owners.push(project.owner_email);
  }
  return { owners: [...new Set(owners)], guard: catalogState(catalog.version) };
}
