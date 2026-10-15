import { Icon } from '../../ui/icons';
import { Warning } from '../../ui/parts';
import { Slip, Tile } from './Slip';

// The small slip beside each differentiator. Each copies a real Coaster screen's layout and labels.

export const ReconciledSlip = () => (
  <Slip className="draw-slip">
    <p className="draw-head land-num">RB-0001 · AUD 1,284.60</p>
    <p className="draw-label">Reimbursements</p>
    {[['Sam Taylor', 'AUD 369.46'], ['Priya Nair', 'AUD 512.30'], ['Morgan Lee', 'AUD 402.84']].map(([name, total]) => (
      <p key={name} className="land-row land-row-plain"><span>{name}</span><span className="land-num">{total}</span></p>
    ))}
    <p className="land-checkline"><span className="land-check land-check-solid"><Icon name="check" /></span>Reconciled</p>
    <p className="draw-button draw-button-outline">Download accounting CSV</p>
  </Slip>
);

export const FreeSlip = () => (
  <Slip className="draw-slip">
    <p className="draw-head">MIT License</p>
    <p className="draw-line">Copyright (c) 2026 Run Edit Run</p>
    <p className="land-row"><Tile><Icon name="document" /></Tile><span>installation.rer</span></p>
  </Slip>
);

export const PolicySlip = () => (
  <Slip className="draw-slip">
    <p className="land-row land-row-top"><Tile><Icon name="lines" /></Tile><span><strong>Rockpool Dining</strong><span className="draw-muted">Meals · 100%</span></span><span className="land-num">180.00</span></p>
    <p className="draw-warning"><Warning>Over the Meals limit of AUD 120.00</Warning></p>
    <p className="draw-line"><strong>Explanation:</strong> Client dinner for four, agreed with Priya</p>
  </Slip>
);

export const HistorySlip = () => (
  <Slip className="draw-slip">
    <p className="draw-head">History</p>
    <ol className="draw-timeline">
      <li>Approved by Priya Nair · 1 exception acknowledged</li>
      <li>Resubmitted by Sam Taylor as revision 2</li>
      <li>Returned by Priya Nair · Attach the bistro receipt</li>
    </ol>
  </Slip>
);

export const AgentsSlip = () => (
  <Slip className="draw-slip">
    <p className="draw-head draw-head-icon"><span className="draw-badge"><Icon name="spark" /></span>Prepared for you</p>
    <p className="draw-line land-num">Uber receipts · AUD 38.60</p>
    <p className="draw-line draw-muted">Prepared by Receipt inbox agent · 1 expense</p>
    <p className="draw-buttons"><span className="draw-button draw-button-dark">Accept as draft</span><span className="draw-button draw-button-outline">Decline</span></p>
  </Slip>
);

export const MoveInSlip = () => (
  <Slip className="draw-slip">
    <p className="draw-head draw-head-icon"><span className="draw-badge"><Icon name="upload" /></span>Preview · nothing imported yet</p>
    <p className="draw-line">12 reports · 48 expenses</p>
    <p className="draw-button draw-button-dark draw-button-wide">Import 12 reports</p>
  </Slip>
);
