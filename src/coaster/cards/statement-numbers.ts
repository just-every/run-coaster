/** Redact every representation of the supplied account numbers before deriving any statement facts. */
export function maskStatementNumbers(raw: string, numbers: Iterable<string>, representations: Iterable<string> = []): string {
  let masked = raw;
  const hide = (value: string) => {
    const count = value.replace(/\D/g, '').length;
    let digit = 0;
    return value.replace(/\d/g, char => ++digit <= count - 4 ? '*' : char);
  };
  // The mapped CSV cell may contain issuer-specific formatting beyond common separators.
  for (const value of [...new Set(representations)].sort((a, b) => b.length - a.length)) {
    if (value.replace(/\D/g, '').length > 4) masked = masked.split(value).join(hide(value));
  }
  for (const number of new Set(numbers)) {
    if (!/^\d{5,}$/.test(number)) continue;
    const pattern = new RegExp(number.split('').join('[\\s./-]*'), 'g');
    masked = masked.replace(pattern, hide);
  }
  return masked;
}
