import type { ReactNode } from 'react';
import { CoasterAvatar, Connector, Cursor, Dot, Heading, Initials, Section, Spark, Tick } from '../kit';
import '../../styles/return.css';

type Step = { time: string; tone: 'done' | 'fail' | 'wait'; card: ReactNode; note?: string; megan?: boolean; last?: boolean };
const DAYS: { day: string; steps: Step[] }[] = [
  { day: 'Tue Oct 13', steps: [
    { time: '9:00 am', tone: 'done', card: <>22 of 23 settled<span className="sep">·</span>$9,037.40 <Tick /></> },
    { time: '9:02 am', tone: 'fail', card: <>ACH to Jordan Pike<span className="sep">·</span>$448.80<span className="sep">·</span><br className="rt-br" />returned R03: no account</>, note: 'The bank couldn’t find the account ending 2290 · $448.80 back on Jordan’s balance' },
    { time: '9:03 am', tone: 'wait', card: <>QuickBooks: Jordan’s bill payment reversed</> },
    { time: '11:20 am', tone: 'done', card: <>New account ••7731 verified instantly</>, note: 'notice sent to Jordan’s previous email · payments held 2 days' },
  ] },
  { day: 'Thu Oct 15', steps: [{ time: '11:30 am', tone: 'done', megan: true, card: <>Hold lifted<span className="sep">·</span>resend prepared by Coaster, released by Megan<span className="sep">·</span>$448.80<span className="sep">·</span>QuickBooks bill payment re-posted</> }] },
  { day: 'Fri Oct 16', steps: [{ time: '', tone: 'done', last: true, card: <>Settled <span className="nowrap"><Tick /><span className="sep">·</span></span>C-1186 paid in full</> }] },
];

/** Page 07: the one failure on the page, Jordan's returned ACH payment, and its recovery by Friday with the books kept right. */
export function Return() {
  return <Section id="return">
    <div className="rt-grid stage">
      <ol className="rt-line" aria-label="Tue Oct 13 to Fri Oct 16">
        {DAYS.map(({ day, steps }) => <li key={day} className="rt-day"><p className="rt-date">{day}</p>
          <ol>{steps.map(step => <li key={step.time + day} className={`rt-step rt-s-${step.tone}${step.last ? ' rt-last' : ''}`}>
            <span className="rt-time">{step.time}</span>
            <span className="rt-node"><Dot tone={step.tone} />{step.megan && <Cursor who="Megan" className="rt-cur-megan cursor-left" />}{step.last && <><Spark className="rts-1" turn={-70} /></>}</span>
            <div><p className="card card-tight rt-card">{step.card}</p>{step.note && <p className="rt-note">{step.note}</p>}</div>
          </li>)}</ol>
        </li>)}
      </ol>
      <div className="rt-side">
        <Heading id="return-title" eyebrow="Return · Tue Oct 13 → Fri Oct 16" first="The bank sent it back." second="Paid by Friday." lead="One of 23 payments came back. Coaster said why in plain words, got the new account, and kept the books right while it waited." />
        <div className="card rt-chat">
          <div className="msg"><CoasterAvatar /><div><p><b>Coaster</b><span className="sep">·</span><span className="quiet">9:04 am</span></p><p>Your $448.80 reimbursement came back: your bank couldn’t find the account ending 2290. Update your bank details here →</p></div></div>
          <div className="msg"><Initials>JP</Initials><div><p><b>Jordan</b><span className="sep">·</span><span className="quiet">11:20 am</span></p><p>Credit union merger gave me a new number</p></div></div>
          <Cursor who="Jordan" className="rt-cur-jordan" />
        </div>
        <p className="rt-done"><Dot /><span>Bank updated<span className="sep">·</span>resent Thu Oct 15<span className="sep">·</span>settled Fri Oct 16 <span className="nowrap"><Tick /><span className="sep">·</span></span><br className="rt-br" />QuickBooks 23 bills paid<span className="sep">·</span>0 errors</span></p>
        <Connector className="rtk" w={170} h={60} d="M4 52C60 56 120 40 160 8" head="M146 6l14 2-4 14" />
      </div>
    </div>
  </Section>;
}
