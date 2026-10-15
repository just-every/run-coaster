import { Brand } from './Brand';
import { links } from './links';

/** The run site's footer: the mark and name, the one line, and the plain links. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-wrap site-footer-row">
        <Brand />
        <p className="site-footer-line">Expenses and reimbursement you run yourself.</p>
        <nav className="site-footer-links" aria-label="Footer">
          <a href={links.docs}>Docs</a>
          <a href={links.source}>Source</a>
          <a href={`${links.source}/blob/main/LICENSE`}>MIT licensed</a>
        </nav>
      </div>
    </footer>
  );
}
