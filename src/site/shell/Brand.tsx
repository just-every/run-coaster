/** The coral pinked-edge disc and the name, set in the sans as everywhere in Coaster. */
export function Brand({ href = '/' }: { href?: string }) {
  return <a className="site-brand" href={href}><img src="/brand/mark.svg" alt="" width="28" height="28" /><span>Coaster</span></a>;
}
