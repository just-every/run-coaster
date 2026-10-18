import '../styles/site.css';
import '../styles/kit.css';
import { SiteFooter } from '../shell/SiteFooter';
import { SiteHeader } from '../shell/SiteHeader';
import { Approve } from './sections/Approve';
import { Capture } from './sections/Capture';
import { Chase } from './sections/Chase';
import { Close } from './sections/Close';
import { Closing } from './sections/Closing';
import { Hero } from './sections/Hero';
import { Match } from './sections/Match';
import { MoveIn } from './sections/MoveIn';
import { Policy } from './sections/Policy';
import { Read } from './sections/Read';
import { Return } from './sections/Return';
import { Trip } from './sections/Trip';
import { TripMap } from './sections/TripMap';

/**
 * run-coaster.com's homepage, built from the design desk's approved page (18 Oct 2026, structure s1) in its order:
 * the hero; Jordan Pike's Denver client trip from the first forwarded receipt to the reimbursement settling (trip,
 * capture, read, match, approve and pay, the return, the map); then Megan Ortiz's month (chase, close, the hotel-cap
 * replay, moving in) and the closing with the footer. Every drawing is HTML, CSS and inline SVG.
 */
export function Landing() {
  return <>
    <SiteHeader />
    <main id="main">
      <Hero />
      <Trip />
      <Capture />
      <Read />
      <Match />
      <Approve />
      <Return />
      <TripMap />
      <Chase />
      <Close />
      <Policy />
      <MoveIn />
      <Closing />
    </main>
    <SiteFooter />
  </>;
}
