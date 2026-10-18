/** The lockup: the receipt-roll mark beside the heavy "Coaster" wordmark in the heading face. */
export function Brand({ href = '/' }: { href?: string }) {
  return <a className="site-brand" href={href}><img src="/brand/mark.svg" alt="" width="58" height="58" /><span>Coaster</span></a>;
}
