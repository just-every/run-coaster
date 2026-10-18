import { Actions } from '../../shell/Actions';
import { Cursor, Mark, Spark, Sticky, Tick } from '../kit';
import '../../styles/closing.css';

/** Page 13: the mascot unrolls its own tape to Jordan's next trip, then the closing line and the actions. */
export function Closing() {
  return <section id="closing" className="sec sec-closing" aria-labelledby="closing-title">
      <div className="site-wrap">
        <div className="co-stage stage">
          <Spark className="cos-1" turn={-30} /><Spark className="cos-2" turn={30} />
          <div className="co-tape" role="img" aria-label="Coaster's tape: C-1186, Denver client trip, paid in full Fri Oct 16; then Jordan's United fare MCI to ORD on Mon Oct 19, $286.40, forwarded from Gmail and read.">
            <div className="co-paper print" aria-hidden="true">
              <p>C-1186<span className="sep">·</span>Denver client trip<span className="sep">·</span>paid in full Fri Oct 16 <Tick /></p>
              <p className="co-next">Forwarded from Gmail<span className="sep">·</span>United<span className="sep">·</span>MCI → ORD<span className="sep">·</span>Mon Oct 19<span className="sep">·</span>$286.40<span className="sep">·</span>read <Tick /></p>
            </div>
          </div>
          <Cursor who="Jordan" className="co-cur" />
          <div className="co-mascot" aria-hidden="true"><Mark /></div>
          <Sticky className="co-sticky">Chicago next!</Sticky>
        </div>
        <div className="co-head">
          <Spark className="cos-3" turn={-70} /><Spark className="cos-4" turn={70} />
          <h2 id="closing-title"><span>Back on the road</span> <span className="h-second">by Monday.</span></h2>
          <p className="co-free">100% free and open source. MIT licensed.</p>
          <Actions demo={false} />
        </div>
      </div>
    </section>;
}
