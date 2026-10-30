import { validateFeedHealthArchive } from './feed-health-archive.mjs';
import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** A portable delivery history has no live transport authority or installation credentials. */
export async function validateProgramFeedArchive(read) {
  const [feeds, deliveries, categories, files] = await Promise.all(['c_program_feeds', 'c_program_deliveries', 'c_categories', 'c_statement_files'].map(read));
  const check = value => { if (!value) throw new PortabilityError('coaster_program_feed', 409); };
  const feedIds = new Set(feeds.map(row => row.id)), categoryIds = new Set(categories.map(row => row.id));
  for (const row of feeds) {
    check(row.enabled === 0 && row.credentials_sealed === null && row.lease_id === null && row.lease_until === 0 && row.next_run_at === 0 && categoryIds.has(row.category_id));
    let mapping; try { mapping = JSON.parse(row.mapping); } catch { check(false); }
    check(mapping && typeof mapping === 'object' && !Array.isArray(mapping) && typeof mapping.sequence === 'string');
    check(Number.isSafeInteger(row.version) && row.version > 0 && Number.isSafeInteger(row.interval_minutes) && row.interval_minutes >= 60 && row.interval_minutes <= 1440 && row.interval_minutes % 60 === 0);
  }
  for (const row of deliveries) check(feedIds.has(row.feed_id) && (!row.file_id || files.some(file => file.id === row.file_id && file.source === 'program-feed')) && /^[0-9a-f]{64}$/.test(row.sha256) && typeof row.issuer_sequence === 'string' && row.issuer_sequence.length > 0 && Number.isSafeInteger(row.charges) && row.charges >= 0);
  await validateFeedHealthArchive(read);
  for (const file of files.filter(row => row.source === 'program-feed')) check(deliveries.some(row => row.file_id === file.id));
}
