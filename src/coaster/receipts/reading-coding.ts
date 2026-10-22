import type { Bindings } from '../../auth.server';
import { all, authority, commit } from '../session';
import { requireThat, type Actor, type Data } from '../types';
import { prepareReadingCoding } from '../coding/automatic/receipt-understanding';
import { readingCodingInput, readingDetail } from './reading';
import { currentSettings, settingsStill } from './reading/settings';
import { captureState } from './reading/access';

/** Only verified private reading facts enter source five; request JSON carries consent and current versions. */
export async function suggestReadingCoding(env: Bindings, actor: Actor, id: string, body: Data) {
  requireThat(Object.keys(body).every(key => ['expectedSequence', 'expectedReadingSequence', 'contextVersion', 'consent'].includes(key)) && body.consent === true, 'Explicit consent to prepare coding from this receipt reading is required');
  const detail = await readingDetail(env.DB, actor, id);
  requireThat(body.expectedSequence === detail.lifecycleSequence && body.expectedReadingSequence === detail.sequence, 'The receipt reading changed; reload before preparing coding', 409);
  const read = await readingCodingInput(env.DB, actor, id), settings = (await currentSettings(env.DB))!;
  requireThat(settings.enabled, 'Receipt reading and coding are disabled', 409);
  const result = await prepareReadingCoding(env.DB, { ...env, AI_MODEL: settings.model }, actor, read, { enabled: true, employeeConsented: true, minimumConfidence: settings.threshold, guard: all(read.guard, settingsStill(settings.version)) }, { contextVersion: body.contextVersion });
  if (result.status === 'review') await commit(env.DB, all(authority(actor, 'employee'), read.guard, settingsStill(settings.version)), [captureState(env.DB, actor, id, 'needs-attention', result.reason)]);
  return result;
}
