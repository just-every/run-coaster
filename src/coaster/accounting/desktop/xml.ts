import { requireThat } from '../../types';

export const escapeXml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export type Element = { name: string; attributes: Record<string,string>; children: Element[]; value: string };
const decode = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_s, c: string) => c[0] === '#' ? String.fromCodePoint(parseInt(c.slice(c[1] === 'x' ? 2 : 1), c[1] === 'x' ? 16 : 10)) : ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[c]!));
/** Bounded XML subset used by SOAP and qbXML. No DTD, external entities or processing instructions beyond declarations. */
export function parseXml(input: string): Element {
  requireThat(input.length <= 2_000_000 && !/<!DOCTYPE|<!ENTITY/i.test(input), 'Unsupported or oversized XML');
  const root: Element = { name: '', attributes: {}, children: [], value: '' }, stack = [root];
  const tokens = input.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]+>|[^<]+/g) ?? [];
  requireThat(tokens.join('') === input, 'Malformed XML');
  for (const token of tokens) {
    const parent = stack.at(-1)!;
    if (token.startsWith('<?') || token.startsWith('<!--')) continue;
    if (token.startsWith('<![CDATA[')) { parent.value += token.slice(9,-3); continue; }
    if (token.startsWith('</')) {
      const name = token.slice(2,-1).trim().split(':').at(-1);
      requireThat(stack.length > 1 && parent.name === name, 'Malformed XML closing tag'); stack.pop();
    } else if (token.startsWith('<')) {
      const match = token.match(/^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>$/);
      requireThat(match && stack.length < 40, 'Malformed XML element');
      const attributes: Record<string,string> = {};
      for (const attr of match[2].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[attr[1].split(':').at(-1)!] = decode(attr[2] ?? attr[3]);
      const node: Element = { name: match[1].split(':').at(-1)!, attributes, children: [], value: '' };
      parent.children.push(node); if (!match[3]) stack.push(node);
    } else parent.value += decode(token);
  }
  requireThat(stack.length === 1 && root.children.length === 1 && !root.value.trim(), 'Malformed XML document');
  return root.children[0];
}
export const child = (node: Element, name: string) => node.children.find(c => c.name === name);
export const value = (node: Element, name: string) => child(node,name)?.value ?? '';
export const tag = (name: string, content: unknown) => `<${name}>${escapeXml(content)}</${name}>`;
export const ref = (name: string, id: string) => `<${name}>${tag('ListID',id)}</${name}>`;
export const qbxml = (body: string) => `<?xml version="1.0"?><?qbxml version="13.0"?><QBXML><QBXMLMsgsRq onError="stopOnError">${body}</QBXMLMsgsRq></QBXML>`;
export function soapResult(method: string, result: string) {
  return new Response(`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method}Response xmlns="http://developer.intuit.com/"><${method}Result>${result}</${method}Result></${method}Response></soap:Body></soap:Envelope>`, { headers: { 'content-type':'text/xml; charset=utf-8','cache-control':'no-store' } });
}
