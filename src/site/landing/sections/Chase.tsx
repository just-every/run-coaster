import { Cursor, Dot, Heading, Icon, Initials, Pill, Section, Spark, Sticky, Tick } from '../kit';
import '../../styles/chase.css';

const ROWS = [
  { chip: 'TN', name: 'Trevor Nash', charge: 'Casey’s · $58.40', posted: 'Fri Oct 9', reminded: 'Wed Oct 14', note: 'Mon Oct 12 holiday skipped', next: 'Mon Oct 19' },
  { chip: 'AG', name: 'Alyssa Grant', charge: 'Hampton Inn Omaha · $241.36', posted: 'Tue Oct 13', reminded: 'Thu Oct 15', next: 'Tue Oct 20' },
  { chip: 'KR', name: 'Kevin Ruiz', charge: 'Home Depot · $146.88', posted: 'Wed Oct 14', reminded: 'Fri Oct 16, 8:00 am', next: 'Wed Oct 21' },
];

/** Page 09: Megan's month begins. The October Amex feed has 14 card charges without receipts, and Coaster is chasing them. */
export function Chase() {
  return <Section id="chase">
    <div className="ch-stage stage">
      <div className="ch-top">
        <div className="ch-copy"><Spark className="chs-1" turn={30} /><Heading id="chase-title" eyebrow="Chase · Fri Oct 16" first="Fourteen receipts out." second="Coaster is asking." lead="Reminders go out on business days, skip the bank holiday and quiet hours, and stop the moment the receipt lands." /></div>
        <div className="card ch-file"><p className="ch-card-title">Amex daily file</p><p>last Fri Oct 16, 8:00 am <Tick /></p><p>next Mon Oct 19</p><p className="quiet ch-file-note">Mon Oct 12 bank holiday, no file expected</p></div>
        <div className="card ch-feed"><p className="ch-card-title">October Amex feed</p><dl><div><dt>charges</dt><dd>412</dd></div><div><dt>receipts matched</dt><dd>398</dd></div><div><dt>being chased</dt><dd>14</dd></div></dl></div>
      </div>
      <div className="card ch-table">
        <p className="ch-table-title">Being chased · 14</p>
        <table>
          <thead><tr><th>Person</th><th>Charge</th><th>Status</th><th>Posted</th><th>Reminded</th><th>Next</th></tr></thead>
          <tbody>{ROWS.map(row => <tr key={row.name}>
            <td className="ch-person"><Initials tone="mint">{row.chip}</Initials>{row.name}</td>
            <td data-label="Charge">{row.charge}</td>
            <td><Pill tone="amber">receipt missing</Pill></td>
            <td data-label="Posted">{row.posted}</td>
            <td data-label="Reminded">{row.reminded}{row.note && <span className="quiet ch-note">{row.note}</span>}</td>
            <td data-label="Next">{row.next}</td>
          </tr>)}</tbody>
        </table>
        <p className="ch-more">+ 11 more</p>
        <div className="ch-foot">
          <p className="ch-schedule"><Icon name="clock" /><span>After 2, 5 and 10 business days<span className="sep">·</span>quiet hours 7 pm – 8 am local<span className="sep">·</span>then the manager, then Megan</span></p>
          <div className="card ch-closed"><Dot /><div><p><b>Closed this week: 27 chases</b></p><p className="quiet">each stopped when the receipt arrived <Tick /></p></div></div>
        </div>
        <Sticky className="ch-sticky">Haven’t chased anyone in October!</Sticky>
        <Spark className="chs-2" turn={40} />
        <Cursor who="Megan" className="ch-cur" />
      </div>
    </div>
  </Section>;
}
