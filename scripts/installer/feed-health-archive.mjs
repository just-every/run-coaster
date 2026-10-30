import { PortabilityError } from '@runeditrun/rer/modules/portability';
import { parseCsv } from '../../src/coaster/imports/csv-parser.mjs';
import { deadline, deliveryPeriod, hasCalendar } from '../../src/coaster/feeds/calendar.mjs';

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const bytes = value => Buffer.from(value?.blob ? value.blob : value instanceof ArrayBuffer ? new Uint8Array(value) : value ?? [], value?.blob ? 'base64' : undefined);

/** Recompute coverage from the retained, hash-checked source; archive labels confer no coverage authority. */
export async function validateFeedHealthArchive(read) {
  const check = value => { if (!value) throw new PortabilityError('coaster_feed_health',409); };
  const [feeds,deliveries,files,history,events] = await Promise.all(['c_program_feeds','c_program_deliveries','c_statement_files','c_program_health','c_events'].map(read));
  for (const f of feeds) {
    const fields=[f.delivery_time,f.delivery_timezone,f.grace_minutes,f.expected_from];
    check(fields.every(v=>v===null) || fields.every(v=>v!==null));
    if(hasCalendar(f)) {
      check(/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(f.delivery_time) && validDate(f.expected_from) && Number.isSafeInteger(f.grace_minutes) && f.grace_minutes>=0 && f.grace_minutes<=1440);
      try { new Intl.DateTimeFormat('en',{timeZone:f.delivery_timezone}); } catch { check(false); }
    }
  }
  for (const d of deliveries.filter(d=>d.coverage_date!==null)) {
    const f=feeds.find(f=>f.id===d.feed_id),file=files.find(file=>file.id===d.file_id);
    check(f && hasCalendar(f) && file && file.source==='program-feed' && file.sha256===d.sha256 && timestamp(d.received_at));
    let parsed; try { parsed=parseCsv(bytes(file.bytes).toString('utf8')); } catch { check(false); }
    check(validDate(d.coverage_date) && deliveryPeriod(f,parsed.headers,parsed.rows,new Date(d.received_at))===d.coverage_date);
    const mapping=JSON.parse(f.mapping);
    check(parsed.rows.every(row=>row[mapping.sequence]?.trim()===d.issuer_sequence));
    check(history.some(h=>h.feed_id===d.feed_id && h.delivery_date===d.coverage_date && h.kind==='covered'));
  }
  check(new Set(history.map(h=>h.seq)).size===history.length && new Set(history.map(h=>[h.feed_id,h.delivery_date,h.kind].join('|'))).size===history.length);
  for (const h of history) {
    const f=feeds.find(f=>f.id===h.feed_id);
    check(f && hasCalendar(f) && Number.isSafeInteger(h.seq) && h.seq>0 && validDate(h.delivery_date) && h.delivery_date>=f.expected_from && timestamp(h.at));
    if(h.kind==='covered') check(deliveries.some(d=>d.id===h.delivery_id && d.feed_id===h.feed_id && d.coverage_date===h.delivery_date && d.received_at===h.at));
    else check(h.kind==='missed' && h.delivery_id===null && Date.parse(h.at)>=deadline(f,h.delivery_date));
    check(events.some(e=>{let detail;try{detail=JSON.parse(e.detail)}catch{return false}return e.action===`program-feed-date-${h.kind}` && detail.feed===h.feed_id && detail.date===h.delivery_date && (h.kind!=='covered'||detail.delivery===h.delivery_id)}));
  }
}
