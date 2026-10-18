import { Connector, Cursor, Dot, Heading, Icon, Initials, Pill, Section, Spark, Sticky, Tick } from '../kit';
import '../../styles/policy.css';

const CITIES: [string, number][] = [['Denver', 14], ['Chicago', 11], ['Dallas', 8], ['Minneapolis', 6], ['Other', 2]];

/** Page 11, the push-further screen: Coaster proposes a hotel-cap change and replays it on twelve months of trips before Megan adopts it. */
export function Policy() {
  return <Section id="policy">
    <Heading id="policy-title" align="center" eyebrow="Policy · Tue Nov 3" first="New hotel cap," second="tested on last year first." lead="Coaster spotted an exception everyone approves anyway, proposed the fix, and replayed it on 12 months of trips before Megan said yes." />
    <div className="po-grid stage">
      <div className="card po-find">
        <div className="po-find-head"><span className="po-spark"><Spark /></span><div><p className="po-card-title">Lodging over $175 a night</p><p className="quiet">41 times<span className="sep">·</span>Nov 2025 – Oct 2026<span className="sep">·</span>41 of 41 approved<span className="sep">·</span>9 people</p></div></div>
        <ul className="po-bars" aria-label="Exceptions by city">
          {CITIES.map(([city, n]) => <li key={city}><span>{city}</span><span className="po-track"><i style={{ width: `${(n / 14) * 100}%` }} /></span><span className="num">{n}</span></li>)}
        </ul>
        <Sticky className="po-sticky">Denver again!</Sticky>
        <p className="po-row"><Initials tone="mint">JP</Initials><span>Jordan Pike<span className="sep">·</span>Blake Street Hotel<span className="sep">·</span>$179<span className="sep">·</span>Oct 6–8</span></p>
        <p className="po-proposal"><Icon name="list" /><b>Proposal: $215 a night in Denver, Chicago, Dallas and Minneapolis; $175 everywhere else</b></p>
      </div>
      <Connector dotted className="pok" w={100} h={60} d="M4 6C40 4 70 20 92 52" head="M80 48l12 6 0-14" />
      <div className="card po-replay">
        <p className="po-card-title">Replay on 12 months</p>
        <table>
          <thead><tr><th /><th>Today (v7)</th><th>Proposed (v8)</th></tr></thead>
          <tbody>
            <tr><th>Exceptions</th><td>41</td><td><span className="po-arrow" aria-hidden="true">→</span><span className="sr-only">to </span>4</td></tr>
            <tr><th>Reimbursed amounts</th><td colSpan={2}>unchanged<span className="sep">·</span>$0.00</td></tr>
            <tr><th>Approver reviews</th><td colSpan={2}>37 fewer</td></tr>
            <tr><th>Affected people</th><td colSpan={2}>9</td></tr>
          </tbody>
        </table>
        <p className="po-open"><Pill tone="line">Affected expenses<span className="sep">·</span><span className="po-open-word">Open</span></Pill></p>
        <p className="po-adopted"><Dot /><span>Adopted by Megan Ortiz<span className="sep">·</span>10:40 am<span className="sep">·</span>policy v8 effective Mon Nov 9<span className="sep">·</span>past decisions keep v7 <Tick /></span></p>
        <p className="po-adopt"><span className="btn-kelly">Adopt</span></p>
        <Spark className="pos-1" turn={70} />
        <Cursor who="Megan" className="po-cur" />
      </div>
    </div>
  </Section>;
}
