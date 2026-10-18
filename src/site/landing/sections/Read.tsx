import { Connector, Cursor, Heading, Initials, Pill, Section, Spark, Tick } from '../kit';
import '../../styles/read.css';

const LINES = [['Oct 6', 'Room', '$179.00'], ['Oct 6', 'Lodging tax', '$27.40'], ['Oct 7', 'Room', '$179.00'], ['Oct 7', 'Lodging tax', '$27.40']];

/** Page 04: the two-page Blake Street Hotel folio read as one $412.80 stay, and the faded MCI parking receipt Jordan confirmed. */
export function Read() {
  return <Section id="read">
    <div className="rd-stage stage">
      <Heading id="read-title" className="rd-head" eyebrow="Read · Thu Oct 8" first="Two nights," second="read as one folio." lead={<>Coaster reads the balance, not the first night,<br className="rd-br" /> splits room from tax, and marks anything it isn’t sure of.</>} />
      <Spark className="rds-1" turn={-15} />
      <div className="rd-folio" role="img" aria-label="The Blake Street Hotel folio, read: guest Jordan Pike, Tue Oct 6 to Thu Oct 8, two nights of room at $179.00 and two lodging tax lines of $27.40, balance $412.80 paid on Visa ending 4417.">
        <div className="rd-sheet rd-sheet-back" aria-hidden="true" />
        <div className="rd-sheet print" aria-hidden="true">
          <p className="rd-name">Blake Street Hotel</p>
          <p>Denver, CO</p>
          <p className="rd-field"><span>Guest:</span><mark>Jordan Pike <Tick /></mark></p>
          <p className="rd-field"><span>Arrive</span><mark>Tue Oct 6 · Depart Thu Oct 8 <Tick /></mark></p>
          <ul className="rd-lines">
            {LINES.map(([day, what, amount], i) => <li key={i}><span className="rd-day">{day}</span><mark><span>{what}</span><span>{amount} <Tick /></span></mark></li>)}
          </ul>
          <svg className="rd-brackets" viewBox="0 0 60 150" aria-hidden="true"><path d="M2 8h14v74H2M24 44h14v74H24" /></svg>
          <p className="rd-total"><mark><span>Balance</span><b>$412.80 <Tick /></b></mark></p>
          <p className="rd-paid"><mark>Paid Visa ••4417 <Tick /></mark></p>
          <p className="rd-page">Page 1 of 2</p>
        </div>
      </div>
      <p className="rd-note rd-note-room" aria-hidden="true">Room: 2 nights × <br />$179.00 = $358.00</p>
      <p className="rd-note rd-note-tax" aria-hidden="true">Lodging tax <br />2 × $27.40 = $54.80</p>
      <p className="rd-note rd-note-balance" aria-hidden="true">balance, not night 1 <br />($206.40)</p>
      <p className="rd-note rd-note-pocket" aria-hidden="true">out of pocket → reimburse</p>
      <Connector className="rdk rdk-1" w={170} h={30} d="M166 12C120 2 60 24 8 14" head="M20 6 8 14l12 8" />
      <Connector className="rdk rdk-2" w={150} h={40} d="M146 34C100 34 60 10 8 6" head="M20 -2 8 6l12 8" />
      <div className="card rd-items">
        <p className="rd-items-title">Itemized</p>
        <p><span>Lodging<span className="sep">·</span>Room</span><span className="num">$358.00</span></p>
        <p><span>Lodging<span className="sep">·</span>Tax</span><span className="num">$54.80</span></p>
        <p className="rd-items-total"><span>Total</span><span className="money">$412.80</span></p>
        <Pill tick>read</Pill>
      </div>
      <Cursor who="Megan" className="rd-cursor" />
      <Spark className="rds-2" turn={20} />
      <div className="rd-mci" role="img" aria-label="The MCI Economy parking receipt: 3 days at $12.00, $36.00, with its faded date marked unclear.">
        <div aria-hidden="true" className="paper torn crumpled print">
          <p>MCI Economy</p>
          <p>3 days × $12.00</p>
          <p className="rd-mci-total">$36.00</p>
          <p className="rd-mci-date"><span className="faded">OCT 0_ 2_</span><Pill tone="amber">date unclear</Pill></p>
        </div>
      </div>
      <Connector className="rdk rdk-3" w={150} h={110} d="M8 4C2 70 60 92 136 92" head="M124 84l12 8-12 8" />
      <div className="card rd-confirm">
        <Initials>JP</Initials>
        <div><Pill tick>Jordan confirmed Thu Oct 8</Pill><p className="quiet">reading and correction kept</p></div>
      </div>
    </div>
  </Section>;
}
