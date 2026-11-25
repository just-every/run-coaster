import { createMailSender } from './modules/mail/index.mjs'

const mailOff = {
 async send() {
  return { status: 'rejected', provider: 'none', providerMessageId: null, code: 'mail_off' }
 },
}

export function operatorMail(env) {
 if (env.MAIL_PROVIDER === 'none') return mailOff
 return env.MAIL_PROVIDER === 'development'
  ? env.AUTH_LOCAL === 'true' || env.RER_DEMO === '1' ? createMailSender({ provider: 'development', mode: 'development' }) : undefined
  : env.MAIL_PROVIDER ? createMailSender({ provider: env.MAIL_PROVIDER, mode: 'production', apiKey: env.MAIL_API_KEY, ...(env.MAIL_PROVIDER === 'rer' && env.MAIL_RELAY_URL?.trim() ? { relayUrl: env.MAIL_RELAY_URL } : {}), ...(env.MAIL_PROVIDER === 'cloudflare' ? { accountId: env.MAIL_ACCOUNT_ID } : {}) }) : undefined
}
