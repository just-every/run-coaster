import { Connector, Cursor, Dot, Heading, Pill, Section, Spark, Tick } from '../kit';
import '../../styles/movein.css';

const ROWS: [string, string, 'ok' | 'review'][] = [
  ['People · with managers, synced from Gusto', '70', 'ok'],
  ['Approvers', '9', 'ok'],
  ['Categories → QuickBooks accounts', '34', 'ok'],
  ['Tags', '12', 'ok'],
  ['Policy rules', '11', 'review'],
  ['Reports · 6 open, carried, reimbursable once', '3,412', 'ok'],
  ['Receipt images', '21,870', 'ok'],
  ['Amex cards assigned', '38', 'ok'],
  ['Overlapping Amex charges Sep 28–30', '47 · 0 doubled', 'ok'],
];

// The one start line every Run Edit Run page shows (the Copy button copies it), and the alternative for people who already have Node.
const START = 'curl -fsSL https://runeditrun.com/install.sh | sh -s -- dev just-every/run-coaster';
const ALTERNATIVE = 'Already have Node 22 or later? npx -y @runeditrun/rer dev just-every/run-coaster';

/** A command that wraps only between words, keeping the installer's `install.sh | sh` together. */
function words(line: string) {
  return line.split(/(\S*install\.sh \| sh|\S+)/).map((part, index) => {
    const pipe = /^(.*\/)(install\.sh \| sh)$/.exec(part);
    if (pipe) return <span key={index}><span className="nowrap">{pipe[1]}</span><wbr /><span className="nowrap">{pipe[2]}</span></span>;
    return part.trim() ? <span key={index} className="nowrap">{part}</span> : part;
  });
}

/** Page 12: how Tallgrass moved off Expensify, and the one line that starts Coaster on your own computer. */
export function MoveIn() {
  return <Section id="move-in">
    <div className="mv-grid stage">
      <div className="mv-copy">
        <Heading id="move-in-title" eyebrow="Moving in · Sat Sep 26 – Thu Oct 1" first="Your Expensify history," second="receipts and all." lead="Coaster read Tallgrass's Expensify account, showed what would move, and took over on Oct 1 with nothing paid twice." />
        <div className="mv-term" role="group" aria-label="Start Coaster on your computer" data-copy={START}>
          <p className="mv-lights" aria-hidden="true"><i /><i /><i /></p>
          <button className="docs-copy mv-copy-btn" type="button" hidden>Copy</button>
          <pre><code><span className="mv-prompt" aria-hidden="true">$ </span>{words(START)}{'\n'}<span className="mv-comment"># {words('installs rer, then gets and starts Coaster on your computer')}</span>{'\n'}<span className="mv-comment"># {words(ALTERNATIVE)}</span></code></pre>
        </div>
        <p className="mv-also">Also moves in from SAP Concur, Emburse, Ramp, Brex and Navan.</p>
      </div>
      <div className="mv-side">
        <Connector dotted className="mvk-1" w={160} h={120} d="M6 114C-4 40 60 4 150 14" head="M138 4l12 10-14 6" />
        <Spark className="mvs-1" turn={30} /><Spark className="mvs-2" turn={-120} />
        <div className="card mv-preview">
          <p className="mv-title">Import preview<span className="sep">·</span>reviewed Sat Sep 26</p>
          <p className="quiet mv-from">From Expensify</p>
          <ul>{ROWS.map(([what, count, state]) => <li key={what}><span>{what}</span><span className="num">{count}</span>{state === 'ok' ? <Dot className="mv-ok" /> : <span className="mv-review-wrap"><Pill tone="amber" className="mv-review">10 mapped + 1 to review</Pill><Cursor who="Megan" className="mv-cur" /></span>}</li>)}</ul>
          <p className="mv-cutover">Cutover Thu Oct 1, 12:00 am<span className="sep">·</span>Amex daily file live <Tick /></p>
        </div>
        <Connector dotted className="mvk-2" w={210} h={60} d="M204 6C180 50 60 66 8 8" head="M4 22l4-14 14 4" />
      </div>
    </div>
  </Section>;
}
