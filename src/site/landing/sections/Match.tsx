import { CoasterAvatar, Connector, Cursor, Heading, Icon, Initials, Pill, Section, Spark, Tick } from '../kit';
import '../../styles/match.css';

const LINES = [
  { merchant: 'United', amount: '$318.40', how: <>Amex ••1008<span className="sep">·</span>matched Fri Oct 2 <Tick /></>, coding: 'Airfare · Sales', source: 'Rule: United → Airfare' },
  { merchant: 'Union Station Grill', amount: '$101.95', how: <>Amex ••1008<span className="sep">·</span>matched 8:00 am <Tick /></>, coding: 'Meals · Sales · Pikes Trail Supply', source: 'Jordan’s past coding' },
  { merchant: 'Lyft', amount: '$38.60', how: <>Amex ••1008<span className="sep">·</span>matched 8:00 am <Tick /></>, coding: 'Ground transport · Sales', source: 'Merchant category' },
  { merchant: 'Blake Street Hotel', amount: '$412.80', how: <>Own card</>, coding: 'Lodging · Sales' },
  { merchant: 'MCI Economy Parking', amount: '$36.00', how: <>Own card</>, coding: 'Parking · Sales' },
];

/** Page 05: Friday's 8:00 am Amex file matches the card lines; Coaster asks Jordan the one thing a receipt can't say. */
export function Match() {
  return <Section id="match">
    <Heading id="match-title" align="center" eyebrow="Match · Fri Oct 9 · 8:00 – 9:31 am" first="Matched to Amex." second="One question in Slack." lead="The morning Amex file matched itself to the receipts. Coaster asked Jordan the one thing a receipt can’t say." />
    <div className="mt-stage stage">
      <Spark className="mts-1" turn={-30} /><Spark className="mts-2" turn={80} />
      <div className="card mt-slack">
        <div className="msg"><CoasterAvatar /><div><p><b>Coaster</b> <span className="quiet">8:02 am</span></p><p>Who was at the $101.95 dinner on Wed Oct 7?</p>
          <dl className="mt-crop torn print"><div><dt>Subtotal</dt><dd>$86.40</dd></div><div><dt>Tip</dt><dd>$15.55</dd></div><div className="mt-crop-total"><dt>Total</dt><dd>$101.95</dd></div></dl>
        </div></div>
        <div className="msg"><Initials>JP</Initials><div><p><b>Jordan</b> <span className="quiet">9:30 am</span></p><p>Me + 2 guests from Pikes Trail Supply</p></div></div>
        <div className="msg"><CoasterAvatar /><div><p><b>Coaster</b></p><p>Added 3 attendees<span className="sep">·</span>$33.98 a person, under the $75 limit <span className="nowrap"><Tick /><span className="sep">·</span></span>C-1186 is complete. Submit?</p>
          <p className="mt-submit"><span className="btn-kelly">Submit</span><Pill tick>Submitted 9:31 am</Pill></p>
        </div></div>
        <Cursor who="Jordan" className="mt-cur-jordan" />
      </div>
      <Connector dotted className="mtk" w={170} h={130} d="M6 124C70 110 60 14 156 12" head="M144 4l12 8-12 8" />
      <p className="card card-tight mt-file"><Icon name="doc" /><span>Amex daily file<span className="sep">·</span>Fri Oct 9, 8:00 am<span className="sep">·</span><span className="nowrap">61 new charges</span><span className="sep">·</span><span className="nowrap">58 matched</span></span></p>
      <div className="card mt-claim">
        <p className="mt-claim-title">Claim C-1186</p>
        <ul>
          {LINES.map(line => <li key={line.merchant}>
            <div><p className="mt-merchant"><b>{line.merchant}</b> <span className="money">{line.amount}</span></p><p className="quiet mt-how">{line.how}</p></div>
            <div className="mt-code"><Pill tone="tag">{line.coding}</Pill>{line.source && <p className="quiet">{line.source}</p>}</div>
          </li>)}
        </ul>
        <p className="mt-totals"><span>Card <b className="money">$458.95</b></span><span className="sep">·</span><span>out of pocket <b className="money">$448.80</b></span><span className="sep">·</span><span>claim <b className="money">$907.75</b></span></p>
        <Cursor who="Megan" className="mt-cur-megan" />
      </div>
    </div>
  </Section>;
}
