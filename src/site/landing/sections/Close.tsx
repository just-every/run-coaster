import { Cursor, Heading, Section, Spark, Tick } from '../kit';
import '../../styles/close.css';

/** Page 10: Mon Nov 2. Coaster ties October's Amex corporate statement to itself and to QuickBooks, and hands Megan the accrual. */
export function Close() {
  return <Section id="close">
    <div className="cl-grid stage">
      <div className="card cl-sheet">
        <p className="cl-title">October close<span className="sep">·</span>Amex corporate statement</p>
        <p className="cl-label">Statement · Oct 1–31</p>
        <dl>
          <div><dt>801 charges</dt><dd>$105,402.15</dd></div>
          <div><dt>6 credits</dt><dd>−$783.75</dd></div>
          <div><dt>Balance</dt><dd>$104,618.40 <Tick /></dd></div>
          <div><dt>Coaster total</dt><dd>$104,618.40 <span className="nowrap"><Tick /><span className="sep">·</span></span>0 differences</dd></div>
          <div><dt>QuickBooks Amex account</dt><dd>799 purchases + 6 credits<span className="cl-sum">$104,231.50 + 2 accrued $386.90 = $104,618.40 <Tick /></span></dd></div>
        </dl>
        <p className="cl-label">Open card spend · 2 · owners chased</p>
        <dl>
          <div><dt>Trevor Nash<span className="sep">·</span>Casey’s<span className="sep">·</span>Fri Oct 30</dt><dd>$118.79</dd></div>
          <div><dt>Kevin Ruiz<span className="sep">·</span>Home Depot<span className="sep">·</span>Sat Oct 31</dt><dd>$268.11</dd></div>
          <div><dt>Pending claims · 3</dt><dd>$1,148.25</dd></div>
        </dl>
        <p className="cl-label">Reimbursements in October</p>
        <dl>
          <div><dt>Fri Oct 9 · 23</dt><dd>$9,486.20</dd></div>
          <div><dt>Fri Oct 23 · 19</dt><dd>$7,904.65</dd></div>
          <div className="cl-paid"><dt>42 paid, all cleared in QuickBooks <Tick /><span className="quiet">1 returned and resent: Jordan Pike</span></dt><dd>$17,390.85</dd></div>
        </dl>
        <p className="cl-foot">QuickBooks Online<span className="sep">·</span>799 card purchases<span className="sep">·</span>42 bills paid<span className="sep">·</span>receipts attached<span className="sep">·</span>0 errors</p>
      </div>
      <div className="cl-side">
        <Heading id="close-title" eyebrow="Close · Mon Nov 2" first="October’s Amex," second="balanced to the cent." lead="Coaster reconciles the statement, lists what’s still open, and hands Megan an accrual ready to post." />
        <Spark className="cls-1" turn={20} />
        <div className="card cl-accrual">
          <p className="cl-accrual-title">Accrual ready</p>
          <p className="cl-accrual-total">$1,535.15</p>
          <p><span>Sales</span><span className="num">$1,102.40</span></p>
          <p><span>Operations</span><span className="num">$432.75</span></p>
          <p className="cl-posted">Posted by Megan Ortiz 3:40 pm <Tick /></p>
          <Cursor who="Megan" className="cl-cur" />
        </div>
      </div>
    </div>
  </Section>;
}
