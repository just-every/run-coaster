import { Icon } from '../../ui/icons';
import { links } from './links';

/** The page's action and its quiet companion: Run Coaster opens the Run page, Try the demo the hosted demo; Read the docs opens /docs. */
export function Actions() {
  return (
    <div className="site-actions-block">
      <div className="site-actions">
        <a className="site-pill" href={links.run}>Run Coaster<Icon name="arrow" /></a>
        <a className="site-pill" href="https://demo.run-coaster.com/">Try the demo</a>
        <a className="site-link" href={links.docs}>Read the docs</a>
      </div>
      <p className="site-small">Free and open source, MIT licensed.</p>
    </div>
  );
}
