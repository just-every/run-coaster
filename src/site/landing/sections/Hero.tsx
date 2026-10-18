import { Actions } from '../../shell/Actions';
import { CoasterAvatar, Connector, Cursor, Dot, Icon, Initials, Pill, Spark, Sticky, Tick } from '../kit';
import '../../styles/hero.css';

/** Page 01: the promise, then a collage of the real records of Jordan's Denver trip, from the read receipt to the books. */
export function Hero() {
  return <section className="hero" aria-labelledby="hero-title">
    <div className="hero-frame">
      <div className="hero-copy">
        <h1 id="hero-title"><span>Snap the receipt.</span> <span className="h-second">Coaster does the rest.</span></h1>
        <p className="hero-sub">Coaster reads every receipt, matches it to the card charge, chases approvals, pays employees by ACH and syncs it all to QuickBooks or Xero.</p>
        <p className="hero-alt">100% free, open source alternative to <b>Expensify</b>, <b>SAP Concur</b> and <b>Emburse</b></p>
        <Actions />
      </div>
      <div className="hero-art">
        <div className="collage" role="img" aria-label="Jordan Pike's $101.95 Union Station Grill receipt read and matched to his Amex charge, Coaster asking who was at dinner in Slack, Dana Kim approving from Slack, a returned ACH payment resent and settled, and QuickBooks Online with 23 bills paid and 0 errors.">
          <div className="collage-inner" aria-hidden="true">
            <Spark className="hs-1" turn={-20} />
            <div className="hc-receipt"><div className="paper torn crumpled">
              <p className="print rc-name">Union Station Grill</p>
              <p className="print rc-line">Denver, CO</p>
              <p className="print rc-line">Wed Oct 7</p>
              <dl className="print rc-sums">
                <div><dt>Subtotal</dt><dd>$86.40</dd></div>
                <div className="rc-tip"><dt>Tip</dt><dd>$15.55</dd></div>
                <div className="rc-total"><dt>Total</dt><dd>$101.95</dd></div>
              </dl>
              <Pill tick>read</Pill>
            </div></div>
            <Connector className="hk-1" w={110} h={44} d="M4 30C30 4 78 0 100 34" head="M90 33l10 1 2-10" />
            <div className="card hc-amex">
              <span className="icon-tile"><Icon name="card" /></span>
              <div className="hc-amex-text">
                <p className="hc-strong">Amex <span className="num">••1008</span></p>
                <p className="quiet">Union Station Grill</p>
                <Pill tick>matched to receipt</Pill>
                <p className="hc-tags"><Pill tone="tag">Meals</Pill><Pill tone="tag">Sales</Pill></p>
              </div>
              <p className="money hc-amount">$101.95</p>
            </div>
            <Cursor who="Megan" className="hcur-megan" />
            <div className="card hc-slack">
              <div className="msg"><CoasterAvatar /><div><p className="hc-strong">Coaster</p><p>Who was at the $101.95 dinner on Wed Oct 7?</p></div></div>
              <div className="msg"><Initials>JP</Initials><div><p className="hc-strong">Jordan</p><p>Me + 2 guests from Pikes Trail Supply</p><Pill tick><span>$33.98 a person<span className="sep">·</span>under $75</span></Pill></div></div>
            </div>
            <Connector className="hk-2" w={70} h={46} d="M4 6c26 0 50 10 56 32" head="M52 32l8 8 5-10" />
            <div className="card hc-approve">
              <Dot />
              <div><p className="hc-strong">Approved by Dana Kim, Sales Director</p><p className="quiet hc-small">from Slack<span className="sep">·</span>Fri Oct 9, 10:14 am <Tick /></p></div>
            </div>
            <Spark className="hs-2" turn={30} />
            <div className="card hc-ach">
              <p className="hc-row hc-row-red"><Dot tone="alert" /><span>ACH to Jordan Pike<span className="sep">·</span>$448.80<span className="sep">·</span>returned R03: no account<span className="sep">·</span>Tue Oct 13</span></p>
              <Icon name="down" className="hc-down" />
              <p className="hc-row hc-row-green"><Dot /><span>Bank updated<span className="sep">·</span>resent Thu Oct 15<span className="sep">·</span>settled Fri Oct 16 <Tick /></span></p>
            </div>
            <Cursor who="Jordan" className="hcur-jordan" />
            <Connector className="hk-3" w={40} h={96} d="M14 4c22 26 22 56 6 84" head="M14 76l6 12 10-8" />
            <div className="card hc-books">
              <span className="hc-books-dot" />
              <div><p className="hc-strong">QuickBooks Online</p><p className="quiet">23 bills paid<span className="sep">·</span>312 card purchases</p><p className="quiet">receipts attached<span className="sep">·</span>0 errors</p></div>
            </div>
            <Spark className="hs-3" turn={-60} />
            <Sticky className="hc-sticky">Jordan’s Denver trip: done by Friday!</Sticky>
          </div>
        </div>
      </div>
    </div>
  </section>;
}
