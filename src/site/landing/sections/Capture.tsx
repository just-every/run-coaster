import { CoasterAvatar, Connector, Cursor, Heading, Icon, Initials, Pill, Section, Spark, Tick } from '../kit';
import '../../styles/capture.css';

const INBOX = [
  { icon: 'mail', name: 'United', amount: '$318.40' },
  { icon: 'camera', name: 'Union Station Grill', amount: '$101.95' },
  { icon: 'chat', name: 'Blake Street Hotel', amount: '$412.80' },
  { icon: 'car', name: 'Lyft', amount: '$38.60' },
  { icon: 'camera', name: 'MCI Economy Parking', amount: '$36.00' },
];

/** Page 03: five receipts reach Jordan's receipt inbox four ways (Gmail forward, camera, Slack, Lyft Business) and build draft C-1186. */
export function Capture() {
  return <Section id="capture">
    <div className="cap-stage stage">
      <Heading id="capture-title" className="cap-head" eyebrow="Capture · Oct 1 – 8" first="Five receipts," second="four ways in." lead="Snap it, forward it, drop it in Slack, or let Lyft send it. Each one lands in Jordan's receipt inbox and is read." />
      <Spark className="cs-1" turn={10} />
      <div className="phone" aria-label="Jordan's receipt inbox: five receipts, all read" role="img">
        <div className="phone-screen" aria-hidden="true">
          <p className="phone-status"><span>9:41</span><span className="phone-island" /><span className="phone-icons"><i /><i /><i /></span></p>
          <p className="phone-title">Receipts</p>
          <p className="phone-tabs"><span>Received</span><span>Reading</span><span className="on">Read</span></p>
          <ul className="inbox">
            {INBOX.map(row => <li key={row.name}><Icon name={row.icon} /><span><b>{row.name}</b><span className="inbox-amount">{row.amount}</span></span><Pill tick>Read</Pill></li>)}
          </ul>
        </div>
      </div>
      <Spark className="cs-2" turn={-50} />
      <div className="card cap-dm">
        <div className="msg"><Initials>JP</Initials><div><p><b>Jordan</b><span className="sep">·</span><span className="quiet">Thu Oct 8, 9:10 pm</span></p><p className="cap-dm-say">add my Denver trip</p></div></div>
        <div className="msg"><CoasterAvatar /><div><p><b>Coaster</b></p><p className="quiet-ink">Draft claim C-1186<span className="sep">·</span>Denver client trip<span className="sep">·</span>Oct 6–8<span className="sep">·</span>5 receipts<span className="sep">·</span>waiting on 2 card charges</p></div></div>
      </div>
      <Cursor who="Jordan" className="cap-cursor" />
      <p className="cap-label">Four ways in</p>
      <div className="card cap-src cap-gmail"><Icon name="mail" /><div><p className="src-name">Forwarded from Gmail</p><p>United<span className="sep">·</span>MCI → DEN<span className="sep">·</span>$318.40<span className="sep">·</span>Thu Oct 1</p><p className="quiet">original message kept</p></div></div>
      <div className="card cap-src cap-camera"><Icon name="camera" /><div><p className="src-name">Camera</p><p>Union Station Grill<span className="sep">·</span>Wed Oct 7<span className="sep">·</span>8:52 pm MT</p><p>MCI Economy Parking<span className="sep">·</span>Thu Oct 8<span className="sep">·</span>8:31 pm</p></div></div>
      <div className="card cap-src cap-slack"><Icon name="chat" /><div>
        <p><b className="src-name">Slack</b><span className="sep">·</span>Blake Street Hotel folio.pdf<span className="sep">·</span>2 pages<span className="sep">·</span>Thu Oct 8<span className="sep">·</span>7:40 am MT</p>
        <div className="cap-thread">
          <div className="msg"><CoasterAvatar /><div><p><b>Coaster</b></p><p>Read: Blake Street Hotel<span className="sep">·</span>Oct 6–8<span className="sep">·</span>$412.80 <Tick /></p><p>$179 a night is over the $175 cap. Why this hotel?</p></div></div>
          <div className="msg"><Initials>JP</Initials><div><p><b>Jordan</b></p><p>Closest hotel to Pikes Trail; lowest rate that week.</p></div></div>
        </div>
      </div></div>
      <div className="card cap-src cap-lyft"><Icon name="car" /><div><p className="src-name">Lyft Business</p><p>Union Station → DEN<span className="sep">·</span>$38.60<span className="sep">·</span>Thu Oct 8<span className="sep">·</span>2:35 pm MT</p><p className="quiet">arrived on its own</p></div></div>
      <Connector dotted className="ck ck-1" w={250} h={152} d="M246 146C100 146 138 6 12 6" head="M24 -2l-12 8 12 8" />
      <Connector dotted className="ck ck-2" w={298} h={198} d="M294 192C119 192 164 6 12 6" head="M24 -2l-12 8 12 8" />
      <Connector dotted className="ck ck-3" w={238} h={229} d="M234 223C95 223 131 6 12 6" head="M24 -2l-12 8 12 8" />
      <Connector dotted className="ck ck-4" w={306} h={405} d="M302 399C122 399 168 6 12 6" head="M24 -2l-12 8 12 8" />
    </div>
  </Section>;
}
