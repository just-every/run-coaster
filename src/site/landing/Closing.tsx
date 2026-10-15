import { Badge } from '../../ui/parts';
import { Actions } from '../shell/Actions';
import { Slip } from './Slip';

/** The closing band: the one action again, over blank slips fanned low at both edges, the outer two reimbursed. */
export function Closing() {
  return (
    <section className="land-closing" aria-labelledby="closing-title">
      <div className="land-fan" aria-hidden="true">
        {[0, 1, 2, 3].map(i => <Slip key={i} className={`land-fan-slip land-fan-${i}`}>{(i === 0 || i === 3) && <Badge status="reimbursed" />}</Slip>)}
      </div>
      <div className="site-wrap land-closing-copy">
        <h2 id="closing-title" className="land-h2 land-closing-title">Expense claims, sorted.</h2>
        <p className="land-closing-line">Expenses and reimbursement you run yourself.</p>
        <Actions />
      </div>
    </section>
  );
}
