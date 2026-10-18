import { Connector, Mark, Pin, Section, Spark, Tick } from '../kit';
import '../../styles/map.css';

const CHIPS = [
  { name: 'Union Station Grill', amount: '$101.95', at: 'den' },
  { name: 'Blake Street Hotel', amount: '$412.80', at: 'den' },
  { name: 'Pikes Trail Supply', amount: 'client', at: 'den' },
  { name: 'MCI Economy Parking', amount: '$36.00', at: 'mci' },
];

/** Page 08, the mascot moment: the trip on a map, Denver to Kansas City, the Coaster character standing over DEN. */
export function TripMap() {
  return <Section id="map" label="map-tag">
    <div className="mp-stage stage">
      <Spark className="mps-1" turn={-80} /><Spark className="mps-2" turn={30} />
      <div className="mp-mascot" aria-hidden="true"><Mark /><span className="mp-shadow" /></div>
      <Connector className="mpk" w={140} h={50} d="M4 26C40 2 96 2 132 34" head="M118 32l14 2 0-14" />
      <p className="card mp-tag" id="map-tag"><span>Denver client trip<span className="sep">·</span>Oct 6–8<span className="sep">·</span>5 receipts<span className="sep">·</span>$907.75<span className="sep">·</span>paid <Tick /></span></p>
      <div className="card mp-card">
        <div className="mp-map" role="img" aria-label="Map of Colorado, Kansas and Missouri: the route from Denver International (DEN) to Kansas City International (MCI), with Union Station Grill, Blake Street Hotel and Pikes Trail Supply at Denver and MCI Economy Parking at Kansas City.">
          <svg viewBox="0 0 1442 484" aria-hidden="true">
            <path className="st" d="M177 51H620V410H177Z" />
            <path className="st" d="M620 98H1028L1040 110L1050 124L1062 136V410H620Z" />
            <path className="st" d="M1028 65H1318L1334 92L1342 128L1352 168L1372 204L1366 240L1382 276L1374 320L1358 360L1364 394L1350 420L1352 458H1318L1316 432H1062V136L1050 124L1040 110L1028 92Z" />
            <path className="route" d="M490 168C600 130 900 120 1080 214" />
            <g className="plane" transform="translate(728 128) rotate(4) scale(1.6)"><path d="M3 13h12L23 3h5l-4 10h12l4-5h4l-2 7 2 7h-4l-4-5H24l4 10h-5l-8-10H3c-1.2 0-2.2-.8-2.2-2S1.8 13 3 13z" /></g>
            <path className="leg" d="M352 155C390 150 400 175 425 181M358 238C400 238 410 214 438 213M346 324C420 320 460 260 468 225M1100 245C1120 262 1124 284 1112 306" />
            <circle className="ld" cx="425" cy="181" r="7" /><circle className="ld" cx="438" cy="213" r="7" /><circle className="ld" cx="466" cy="225" r="7" /><circle className="ld" cx="1098" cy="245" r="7" />
          </svg>
          <span className="mp-state mp-co">Colorado</span><span className="mp-state mp-ks">Kansas</span><span className="mp-state mp-mo">Missouri</span>
          <span className="mp-pin mp-den"><Pin /><b>DEN</b></span><span className="mp-pin mp-mci"><Pin /><b>MCI</b></span>
        </div>
        <ul className="mp-chips">
          {CHIPS.map(chip => <li key={chip.name} className={`card card-tight mp-chip mp-chip-${chip.at}`}><Mark /><span>{chip.name}<span className="sep">·</span>{chip.amount === 'client' ? <span className="mp-client">client</span> : <b className="money">{chip.amount}</b>}</span>{chip.amount !== 'client' && <Tick />}</li>)}
        </ul>
      </div>
    </div>
  </Section>;
}
