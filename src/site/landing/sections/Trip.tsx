import { Cursor, Dot, Heading, Pill, Section, Spark, Sticky } from '../kit';
import '../../styles/trip.css';

const STOPS: { day: string; time: string; what: string; more?: string; fail?: boolean; jordan?: boolean }[] = [
  { day: 'Thu Oct 1', time: 'United booked', what: 'Forwarded from Gmail' },
  { day: 'Tue Oct 6', time: 'MCI → DEN', what: 'Jordan flies out' },
  { day: 'Wed Oct 7', time: '8:52 pm MT', what: 'Dinner snapped at the table', jordan: true },
  { day: 'Thu Oct 8', time: '7:40 am MT', what: 'Hotel folio sent in Slack' },
  { day: 'Thu Oct 8', time: '2:35 pm MT', what: 'Lyft receipt arrives' },
  { day: 'Thu Oct 8', time: '8:31 pm', what: 'Parking snapped', more: '9:10 pm · Draft claim C-1186' },
  { day: 'Fri Oct 9', time: '10:14 am', what: 'Matched, asked, approved', more: 'Paid out 2:00 pm' },
  { day: 'Tue Oct 13', time: '9:02 am', what: 'ACH returned, R03', fail: true },
  { day: 'Thu Oct 15', time: '11:30 am', what: 'Resent' },
  { day: 'Fri Oct 16', time: 'Settled', what: 'C-1186 paid in full' },
];

/** Page 02: the whole trip as one claim's ten stops, from the forwarded United fare to the reimbursement settling. */
export function Trip() {
  return <Section id="trip">
    <div className="trip-head">
      <Spark className="ts-1" turn={-35} /><Spark className="ts-2" turn={20} />
      <Heading id="trip-title" align="center" eyebrow="Denver client trip · Oct 1 – 16" first="Ten days," second="takeoff to paid back." lead="One sales trip, five receipts, one claim. Jordan snapped and forwarded. Coaster did the rest." />
    </div>
    <div className="trip-stage art">
      <Sticky className="trip-sticky">Jordan never typed an amount!</Sticky>
      <div className="card trip-card">
        <ol className="trip-line">
          {STOPS.map(stop => <li key={stop.day + stop.time} className={stop.fail ? 'stop-fail' : undefined}>
            <Dot tone={stop.fail ? 'fail' : 'done'} />
            {stop.jordan && <Cursor who="Jordan" className="trip-cursor cursor-up" />}
            <p className="stop-day">{stop.day}</p>
            <p className="stop-time">{stop.time}{stop.time === 'Settled' && <svg className="tick tick-ink" viewBox="0 0 16 16" aria-hidden="true"><path d="m2.8 8.7 3.3 3.2 7.1-7.4" /></svg>}</p>
            <p className="stop-what">{stop.what}</p>
            {stop.more && <p className="stop-more">{stop.more}</p>}
          </li>)}
        </ol>
        <div className="trip-foot">
          <p>C-1186<span className="sep">·</span>Denver client trip<span className="sep">·</span>5 receipts<span className="sep">·</span>$907.75</p>
          <Pill tick className="trip-done"><span>Takeoff Tue Oct 6<span className="sep">·</span>paid in full Fri Oct 16</span></Pill>
        </div>
      </div>
    </div>
  </Section>;
}
