import { SiteFooter } from '../shell/SiteFooter';
import { SiteHeader } from '../shell/SiteHeader';
import { AgentsSlip, FreeSlip, HistorySlip, MoveInSlip, PolicySlip, ReconciledSlip } from './drawings';
import { Closing } from './Closing';
import { Feature } from './Feature';
import { Hero } from './Hero';
import { Included } from './Included';
import './styles.css';

/** Coaster's homepage on the run site: the job working end to end, then free, then the rest of the product. */
export function Landing() {
  return (
    <div className="site">
      <SiteHeader />
      <main id="main">
        <Hero />
        <Feature id="reconciled" eyebrow="Reconciled" title="Adds up to the cent." drawing={<ReconciledSlip />}>Every batch’s accounting lines and reimbursements must match its total before anyone pays it. The same expense is never paid twice.</Feature>
        <Feature id="free" eyebrow="Free" title="100% free. Yours to keep." drawing={<FreeSlip />} flip>MIT licensed. Every claim, receipt and decision stays with you, and you can export the lot.</Feature>
        <Feature id="policy" eyebrow="Policy" title="The why travels with it." drawing={<PolicySlip />}>When an expense is over a limit or has no receipt, the employee explains it once. The note stays with the claim, the batch and the export.</Feature>
        <Feature id="history" eyebrow="History" title="Corrected, never erased." drawing={<HistorySlip />} flip>A returned claim comes back as the next revision. Earlier receipts and decisions stay readable.</Feature>
        <Feature id="agents" eyebrow="Agents" title="Your agent drafts. You accept." drawing={<AgentsSlip />}>Give your own agent a key and it prepares draft claims from your receipts. Nothing moves until you accept.</Feature>
        <Feature id="move-in" eyebrow="Move in" title="Bring your Expensify history." drawing={<MoveInSlip />} flip>Preview the export, import exactly what you saw, and undo it if you change your mind. Past reports flag anything claimed again.</Feature>
        <Included />
        <Closing />
      </main>
      <SiteFooter />
    </div>
  );
}
