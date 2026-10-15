import { Icon } from '../../ui/icons';
import { Badge } from '../../ui/parts';
import { Actions } from '../shell/Actions';
import { Disc, Slip, Tile } from './Slip';

const flow = 'Coaster’s flow: a claim is submitted, approved by the manager, and reimbursed in a reconciled batch.';

/** The 1-2-3 of the whole job on three slips, every string a real label: Submitted, Approved, Reimbursed. */
export function Hero() {
  return (
    <section id="top" className="land-hero" aria-labelledby="hero-title">
      <div className="site-wrap">
        <h1 id="hero-title" className="land-h1">Receipts in, everyone paid back.</h1>
        <p className="land-sub">Staff add receipts, managers approve, and finance gets one batch that adds up to the cent.</p>
        <p className="land-alt">100% free, open source alternative to <strong>Expensify</strong>, <strong>Zoho Expense</strong> and <strong>SAP Concur</strong></p>
        <Actions />
        <figure className="land-flow" aria-label={flow}>
          <Slip className="flow-slip">
            <p className="flow-step"><Disc n={1} />Submitted</p>
            <p className="flow-title">Sydney client workshop</p>
            <p className="land-row"><Tile><Icon name="lines" /></Tile><span>Harbour View Bistro</span><span className="land-num">64.50</span></p>
            <p className="land-row"><Tile><Icon name="car" /></Tile><span>142 km</span><span className="land-num">124.96</span></p>
            <p className="flow-chip"><Badge status="submitted" /></p>
          </Slip>
          <span className="flow-arrow" aria-hidden="true"><Icon name="arrow" /></span>
          <Slip className="flow-slip">
            <p className="flow-step"><Disc n={2} />Approved</p>
            <div className="flow-approved"><span className="land-check land-check-big"><Icon name="check" /></span><strong>Approved</strong><span>Approved by Priya Nair</span></div>
          </Slip>
          <span className="flow-arrow" aria-hidden="true"><Icon name="arrow" /></span>
          <Slip className="flow-slip">
            <p className="flow-step"><Disc n={3} />Reimbursed</p>
            <p className="flow-batch">RB-0001</p>
            <p className="flow-total land-num">AUD 1,284.60</p>
            <p className="land-checkline"><span className="land-check land-check-solid"><Icon name="check" /></span>Reconciled</p>
            <p className="flow-chip"><Badge status="reimbursed" /></p>
          </Slip>
        </figure>
      </div>
    </section>
  );
}
