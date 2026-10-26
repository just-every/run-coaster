import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** Bank details travel as a sealed provider token and the last four only; provider credentials and nothing that could ask a provider for anything stay behind. */
export async function validateBankArchive(read) {
  const [accounts, settings, members, events] = await Promise.all(['c_bank_accounts', 'c_bank_settings', 'c_members', 'c_events'].map(read));
  const check = ok => { if (!ok) throw new PortabilityError('coaster_bank', 409); };
  check(settings.length === 1 && Number.isInteger(settings[0].hold_days) && settings[0].hold_days >= 1 && settings[0].hold_days <= 30);
  const ids = new Set(accounts.map(a => a.id));
  check(ids.size === accounts.length);
  for (const a of accounts) {
    check(members.some(m => m.email === a.member_email) && /^\d{4}$/.test(a.last4) && ['plaid', 'stripe'].includes(a.provider) && ['instant', 'microdeposit'].includes(a.method));
    check((a.provider !== 'plaid' || a.method === 'instant') && ['pending', 'active', 'replaced', 'abandoned'].includes(a.state));
    check((a.state === 'pending' || a.state === 'active') === (typeof a.token_sealed === 'string' && a.token_sealed.length > 0) && (a.state === 'pending' || a.state === 'abandoned' ? !a.verified_at : Boolean(a.verified_at)));
    check((a.hold_until === null) === (a.hold_days === null) && (a.hold_released_at === null || a.hold_until !== null) && (a.state === 'replaced') === Boolean(a.replaced_at));
    check(a.previous_id === null || ids.has(a.previous_id));
    // An active or replaced account has the history line that made it, and a replacement the change and hold lines in that order.
    const own = events.filter(e => { try { return JSON.parse(e.detail).account === a.id; } catch { return false; } }).sort((x, y) => x.seq - y.seq).map(e => e.action);
    if (a.state === 'active' || a.state === 'replaced') check(own.includes(a.previous_id ? 'bank-account-changed' : 'bank-account-added'));
    if (a.previous_id) check(own.indexOf('bank-account-changed') >= 0 && own.indexOf('bank-hold-started') === own.indexOf('bank-account-changed') + 1);
    if (a.hold_released_at) check(own.includes('bank-hold-released'));
  }
  for (const m of members) check(accounts.filter(a => a.member_email === m.email && a.state === 'active').length <= 1 && accounts.filter(a => a.member_email === m.email && a.state === 'pending').length <= 1);
}
