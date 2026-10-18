import { Brand } from './Brand';
import { links } from './links';

/** The footer, set in type: the lockup and its line, then Docs, Source and the licence. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-wrap">
        <div>
          <div className="site-footer-lockup"><Brand /><p>Free, open source expense management</p></div>
          <nav aria-label="Footer">
            <a href={links.docs}>Docs</a>
            <a href={links.source}>Source</a>
            <a href={`${links.source}/blob/main/LICENSE`}>MIT licensed</a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
