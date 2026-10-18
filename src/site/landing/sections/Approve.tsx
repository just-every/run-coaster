import { CoasterAvatar, Connector, Cursor, Dot, Heading, Icon, Initials, Section, Spark, Tick } from '../kit';
import '../../styles/approve.css';

const PEOPLE = [['JP', 'Jordan Pike', '$448.80'], ['AG', 'Alyssa Grant', '$1,214.60'], ['BO', 'Ben Ochoa', '$327.15'], ['RK', 'Ruth Kowal', '$92.30']];

/** Page 06: Dana approves C-1186 from Slack; Megan releases Friday's 23 ACH reimbursements and QuickBooks records them. */
export function Approve() {
  return <Section id="approve">
    <div className="ap-stage stage">
      <Heading id="approve-title" className="ap-head" eyebrow="Approve & pay · Fri Oct 9" first="Approved from Slack." second="Sent with 22 others." lead="Dana saw the whole claim and its one explained exception, and approved from her phone. Megan released all 23 payments at 2:00 pm." />
      <Spark className="aps-1" turn={40} /><Spark className="aps-2" turn={60} />
      <div className="card ap-slack">
        <div className="ap-from"><CoasterAvatar /><div>
          <p><b>Coaster</b></p>
          <p className="ap-claim"><b>Jordan Pike</b><span className="sep">·</span><b>Denver client trip</b><span className="sep">·</span>Oct 6–8<span className="sep">·</span>C-1186</p>
          <p className="quiet">$907.75<span className="sep">·</span>5 expenses<span className="sep">·</span>$448.80 to reimburse</p>
        </div></div>
        <p className="ap-rule"><Dot />Lyft $38.60<span className="sep">·</span>approved by rule <Tick /></p>
        <p className="ap-exception"><Dot tone="alert" /><span><b>1 exception, explained:</b> Lodging $179/night over the $175 cap</span></p>
        <p className="ap-quote">“Jordan: Closest hotel to Pikes Trail; lowest rate that week.”</p>
        <p className="ap-buttons"><span className="btn-kelly">Approve</span><span className="btn-line">Hold</span><span className="btn-line">Open</span><Cursor who="Dana" className="ap-cur-dana" /></p>
        <p className="ap-approved"><Dot /><span>Approved by Dana Kim, Sales Director<span className="sep">·</span>from Slack<span className="sep">·</span>Fri Oct 9, 10:14 am <Tick /></span></p>
      </div>
      <Connector className="apk" w={70} h={150} d="M64 4C14 20 0 90 34 140" head="M24 130l10 10 6-12" />
      <div className="card ap-pay">
        <p className="ap-pay-title">Friday reimbursements</p>
        <p className="quiet">Fri Oct 9<span className="sep">·</span>23 people<span className="sep">·</span>$9,486.20<span className="sep">·</span>ACH</p>
        <ul>
          {PEOPLE.map(([chip, name, amount]) => <li key={name}><Initials>{chip}</Initials><span>{name}</span><span className="num">{amount}</span></li>)}
          <li><span className="av av-tile ap-more"><Icon name="plus" /></span><span>+ 19 more</span><span className="num">$7,403.35</span></li>
        </ul>
        <p className="ap-total"><b>Total</b><b className="money">$9,486.20</b></p>
        <p className="ap-release"><span className="btn-kelly">Release</span><Cursor who="Megan" className="ap-cur-megan" /></p>
        <p className="quiet ap-released">Released by Megan Ortiz<span className="sep">·</span>2:00 pm<span className="sep">·</span>standard ACH<span className="sep">·</span>settles Tue Oct 13 (Mon is a bank holiday)</p>
      </div>
      <div className="card card-tight ap-books"><Icon name="doc" /><p><b>QuickBooks</b><span className="sep">·</span>2:05 pm<span className="sep">·</span>23 bills paid<span className="sep">·</span>receipts attached <span className="nowrap"><Tick /><span className="sep">·</span></span>C-1186’s 3 card purchases posted 10:15 am</p></div>
    </div>
  </Section>;
}
