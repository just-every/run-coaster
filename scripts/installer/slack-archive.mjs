import { PortabilityError } from '@runeditrun/rer/modules/portability';

/** Opaque replay evidence travels; workspace execution authority stays behind. */
export async function validateSlackArchive(read) {
  const [answers, comments] = await Promise.all(['c_slack_answers', 'c_comments'].map(read));
  const valid = ok => { if (!ok) throw new PortabilityError('coaster_slack_evidence', 409); };
  valid(new Set(answers.map(a => a.digest)).size === answers.length);
  const referenced = answers.filter(a => a.comment_id !== null).map(a => a.comment_id);
  valid(new Set(referenced).size === referenced.length);
  for (const answer of answers) {
    valid(typeof answer.digest === 'string' && /^[a-f0-9]{64}$/.test(answer.digest));
    valid(answer.comment_id === null || comments.some(c => c.id === answer.comment_id));
  }
}
