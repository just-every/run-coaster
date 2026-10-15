import { createMailSender } from './modules/mail/index.mjs'
import { createD1DevelopmentOutbox } from './modules/mail/src/development/index.mjs'
import { demoEffect } from './modules/demo/index.mjs'

function configuredMail(env) {
 return env.MAIL_PROVIDER === 'development'
  ? env.AUTH_LOCAL === 'true' ? createMailSender({ provider: 'development', mode: 'development' }, { outbox: createD1DevelopmentOutbox({ db: env.DB }) }) : undefined
  : env.MAIL_PROVIDER ? createMailSender({ provider: env.MAIL_PROVIDER, mode: 'production', apiKey: env.MAIL_API_KEY, ...(env.MAIL_PROVIDER === 'cloudflare' ? { accountId: env.MAIL_ACCOUNT_ID } : {}) }) : undefined
}

// Sign-in links and invitations reach people. Under RER_DEMO each one completes as the
// provider's acceptance and nothing is sent or stored; otherwise the configured sender runs.
export function operatorMail(env) {
 if (env.RER_DEMO !== '1') return configuredMail(env)
 return { send: message => demoEffect(() => configuredMail(env).send(message), () => ({ provider: env.MAIL_PROVIDER || 'development', status: 'accepted', providerMessageId: `demo-${message.deliveryId}` })) }
}
