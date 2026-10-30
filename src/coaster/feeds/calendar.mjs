const formats = new Map();
function wall(at, zone) {
  let formatter = formats.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); formats.set(zone, formatter); }
  const p = Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export const feedDate = (at, zone) => wall(at.getTime(), zone).slice(0, 10);
/** A repeated wall time uses its later occurrence. A skipped time moves forward by the daylight-saving gap. */
export function expectedAt(day, time, zone) {
  const target = `${day}T${time}`, guess = Date.parse(target + ':00Z');
  const offsets = new Set([-36, 0, 36].map(hours => {
    const sample = guess + hours * 3_600_000;
    return Date.parse(wall(sample, zone) + ':00Z') - sample;
  }));
  const choices = [...offsets].map(offset => guess - offset), exact = choices.filter(at => wall(at, zone) === target);
  return exact.length ? Math.max(...exact) : Math.min(...choices.filter(at => wall(at, zone) >= target));
}
export const deadline = (f, date) => expectedAt(date, f.delivery_time, f.delivery_timezone) + f.grace_minutes * 60_000;
export const hasCalendar = (f) => !!(f.delivery_time && f.delivery_timezone && f.expected_from && f.grace_minutes !== null);

/** Coverage comes only from equal, valid ISO period boundaries on every row of the accepted source delivery. */
export function deliveryPeriod(f, headers, rows, at) {
  const mapping = JSON.parse(f.mapping);
  if (!hasCalendar(f) || !mapping.periodStart || !mapping.periodEnd || !headers.includes(mapping.periodStart) || !headers.includes(mapping.periodEnd) || !rows.length) return null;
  const columns=Object.entries(mapping).filter(([key])=>!['periodStart','periodEnd','dateFormat','sign','coding','delivery'].includes(key)).map(([,value])=>value);
  if(mapping.periodStart===mapping.periodEnd || columns.includes(mapping.periodStart) || columns.includes(mapping.periodEnd)) return null;
  const periods = rows.map(row => [row[mapping.periodStart]?.trim(), row[mapping.periodEnd]?.trim()]);
  const date = periods[0][0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date || periods.some(([start, end]) => start !== date || end !== date)) return null;
  return date >= f.expected_from && date <= feedDate(at, f.delivery_timezone) ? date : null;
}

