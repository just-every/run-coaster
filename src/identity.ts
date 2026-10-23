// This edition's identity: what its installed Lobby and its run site say.
// The name and colour are the ones setup saves in src/branding.json.
import type { EditionIdentity } from './base/identity'
import branding from './branding.json'
import site from '../deploy-site.json'

export const identity: EditionIdentity = {
  product: branding.name,
  deployment: branding.name,
  purpose: '{deployment} runs expense claims and reimbursement: receipts, approvals, reimbursement batches and the accounting export.',
  tagline: 'Expenses and reimbursement you run yourself.',
  signInPath: '/signin',
  // The run site `rer deploy --site` publishes (deploy-site.json).
  runSite: `https://${site.domain}`,
  // An installed instance serves the Lobby at /.
  installedHome: 'lobby',
  theme: '/rer-theme.css',
  // Linked before the theme: the theme declares the faces, and this file holds the rest of the look (Base's other
  // --rer-* names, Coaster's own tokens and the rules that dress the Lobby and the Run, contract and not-found pages).
  fonts: '/fonts/fonts.css',
  mark: '/brand/mark.svg',
  accentColor: branding.primaryColor,
}
