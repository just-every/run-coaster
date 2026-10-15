import { Icon } from '../../ui/icons';
import { Slip } from './Slip';

const things = [
  ['car', 'Mileage at the ATO rate', 'AUD 0.88 per km by default, and yours to change.'],
  ['cutlery', 'Per diem', 'Days times your daily rate, when you pay one.'],
  ['batches', 'Split across categories', 'One receipt, several categories and cost centres.'],
  ['person', 'One approver each', 'Every employee’s own manager decides.'],
  ['document', 'Every receipt kept', 'Exact bytes, never deleted, always downloadable.'],
  ['restore', 'Export and restore', 'The whole installation, receipts included.'],
] as const;

/** The rest of the product, one small slip each. */
export function Included() {
  return (
    <section id="included" className="land-included" aria-labelledby="included-title">
      <div className="site-wrap">
        <p className="site-eyebrow site-eyebrow-centre">Also included</p>
        <h2 id="included-title" className="land-h2 land-centre">The small things, handled.</h2>
        <ul className="land-tiles">
          {things.map(([icon, title, line]) => (
            <li key={title}><Slip className="land-tile-slip"><span className="land-tile-icon"><Icon name={icon} /></span><h3>{title}</h3><p>{line}</p></Slip></li>
          ))}
        </ul>
      </div>
    </section>
  );
}
