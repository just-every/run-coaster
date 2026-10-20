/** ERASURE-001 / CAPTURE-004: only existing opaque subject/label pairs are tokens. */
export function tokenSubjects(members) {
  return new Set(members.filter(m => typeof m.email === 'string' && /^former-member-[0-9a-f]{8}$/.test(m.email)
    && m.name === 'Former member ' + m.email.slice(-8)).map(m => m.email));
}

function spans(value, subjects) {
  const found = [];
  for (let at = 0; at + 22 <= value.length;) {
    const token = value.slice(at, at + 22), hex = token.slice(-8);
    if (/^(Former member |former-member-)[0-9a-f]{8}$/.test(token) && subjects.has('former-member-' + hex)) {
      found.push({ start: at, end: at + 22 }); at += 22;
    } else at++;
  }
  return found;
}

export function validDiscardReason(value, members) {
  if (typeof value !== 'string' || value !== value.trim() || !value.length || value.length > 22000
    || new TextEncoder().encode(value).length > 22000) return false;
  const collapsed = value.length - 21 * spans(value, tokenSubjects(members)).length;
  return collapsed >= 1 && collapsed <= 1000;
}

/** Replace free text only. Generated tokens are never reconsidered as names. */
export function replaceDiscardIdentity(value, members, address, name, subject, label) {
  const subjects = tokenSubjects(members); subjects.add(subject);
  const replace = (input, needle, replacement, fold) => {
    const protectedSpans = spans(input, subjects);
    let result = '', at = 0;
    const free = text => {
      let output = '';
      for (let i = 0; i < text.length;) {
        const window = text.slice(i, i + needle.length);
        // Length-changing Unicode lowercasing (for example U+0130) is not matched.
        if ((fold ? window.toLowerCase() : window) === needle) { output += replacement; i += needle.length; }
        else output += text[i++];
      }
      return output;
    };
    for (const token of protectedSpans) {
      result += free(input.slice(at, token.start)) + input.slice(token.start, token.end); at = token.end;
    }
    return result + free(input.slice(at));
  };
  return replace(replace(value, address, subject, true), name, label, false);
}
