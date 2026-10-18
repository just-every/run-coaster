// Dates, times and records on the homepage never break across lines ("Fri Oct / 16", "3:40 / pm", "C- / 1186"), and a
// check mark never starts a line alone: inner spaces become no-break spaces, and a hyphen or a range's en dash gets a
// word joiner after it. Separators (`.sep`) still let a line break between records.
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const WHOLE = new RegExp([
  `(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?${MONTH} \\d{1,2}(?:\\u2013\\d{1,2})?(?:, \\d{1,2}:\\d{2} (?:am|pm))?`,
  `${MONTH} \\d{4}`,
  `\\d{1,2}:\\d{2} (?:am|pm)(?: MT)?`,
  `\\b(?:C|CL|RB)-\\d{4}\\b`,
].join('|'), 'g');
const NO_BREAK_SPACE = '\u00a0';
const WORD_JOINER = '\u2060';

const keepText = (text: string) => text.replace(WHOLE, token => token.replace(/ /g, NO_BREAK_SPACE).replace(/([\u2013-])/g, `$1${WORD_JOINER}`));

// A check is an inline SVG, and a line may break on either side of one, so the check and the word before it share one
// no-wrap span (an existing one is widened back to take in the word).
const TICK = '<svg class="tick"[^>]*>(?:(?!</svg>).)*</svg>';

/** The page's HTML with every date, time, record and check kept whole; markup and attributes are untouched. */
export function keepWhole(html: string): string {
  return html
    .replace(/>([^<]+)</g, (_, text: string) => `>${keepText(text)}<`)
    .replace(/([^ <>]+) <span class="nowrap"><svg class="tick"/g, `<span class="nowrap">$1${NO_BREAK_SPACE}<svg class="tick"`)
    .replace(new RegExp(`([^ <>]+) (${TICK})`, 'g'), `<span class="nowrap">$1${NO_BREAK_SPACE}$2</span>`);
}
