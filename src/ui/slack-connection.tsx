import { useEffect, useState } from 'react';
import { call } from './api';
import { Field, Form, Section } from './parts';

type SlackStatus = {
  connected: boolean;
  workspace?: string;
  connection?: string;
  canConnect: boolean;
  linked: boolean;
  user?: string;
};
type Changed = (message: string) => Promise<void>;

function WorkspaceConnection({ status, changed }: { status: SlackStatus; changed: Changed }) {
  if (!status.canConnect) return null;
  return status.connected ? <Form label="Disconnect Slack" onSubmit={async values => {
    if (values.consent !== true) throw new Error('Confirm that you want to disconnect Slack.');
    await call('chat/slack/disconnect', { consent: true });
    await changed('Slack disconnected.');
  }}>
    <p className="muted field-wide">Disconnecting stops sending new questions and receiving replies through this workspace. Answers already recorded in Coaster remain in claim history.</p>
    <Field label="I authorize disconnecting this Slack workspace" name="consent" type="checkbox" />
  </Form> : <Form label="Connect Slack" onSubmit={async (values, form) => {
    if (values.consent !== true) throw new Error('Authorize the Slack connection before connecting.');
    await call('chat/slack/connect', { botToken: values.botToken, signingSecret: values.signingSecret, consent: true });
    form.reset();
    await changed('Slack connected. Each person must link their own account before receiving questions.');
  }}>
    <p className="muted field-wide">Connect your workspace’s Slack app to send claim questions privately to linked employees and receive signed replies in those question threads. This connection does not accept receipts or grant approval authority.</p>
    <Field label="Slack bot token" name="botToken" type="password" autoComplete="off" spellCheck={false} />
    <Field label="Slack signing secret" name="signingSecret" type="password" autoComplete="off" spellCheck={false} />
    <Field label="I authorize this workspace and app to send claim questions to linked employees and receive their signed thread replies" name="consent" type="checkbox" />
  </Form>;
}

function PersonalLink({ status, changed }: { status: SlackStatus; changed: Changed }) {
  const [sentTo, setSentTo] = useState('');
  return <>
    <h3>Your Slack account</h3>
    {status.linked ? <>
      <p>Your Coaster account is linked{status.user ? <> to Slack user <strong>{status.user}</strong></> : ' to Slack'}.</p>
      <Form label="Unlink my Slack account" onSubmit={async () => {
        await call('chat/slack/unlink', {});
        setSentTo('');
        await changed('Your Slack account was unlinked.');
      }}><p className="muted field-wide">Unlinking stops future claim questions to your Slack account. Recorded answers remain visible to people who can read the claim.</p></Form>
    </> : status.connected ? <>
      <p>Link only your own Slack account. Coaster sends a one-time code privately to that account; enter it here to prove it is yours.</p>
      <Form label="Send Slack verification code" onSubmit={async (values, form) => {
        if (values.consent !== true) throw new Error('Authorize private claim questions before requesting a code.');
        const user = String(values.user).trim();
        await call('chat/slack/link/start', { user, consent: true });
        setSentTo(user);
        form.reset();
      }}>
        <Field label="Your Slack member ID" name="user" placeholder="U0123456789" autoComplete="off" hint="In Slack, open your profile, choose More, then Copy member ID." />
        <p className="muted field-wide">Named claim questions will be sent privately to you in Slack. Your answers will be recorded in Coaster and shared with people who can read the claim.</p>
        <Field label="I consent to receive private claim questions in Slack and share my answers with claim readers" name="consent" type="checkbox" />
      </Form>
      {sentTo && <p role="status" aria-live="polite">Verification code sent privately to {sentTo}. Enter it below.</p>}
      <div className="sub-form"><Form label="Confirm my Slack account" onSubmit={async (values, form) => {
        await call('chat/slack/link/confirm', { code: String(values.code).trim() });
        form.reset();
        setSentTo('');
        await changed('Your Slack account is linked.');
      }}>
        <Field label="Code from your Slack direct message" name="code" autoComplete="one-time-code" />
      </Form></div>
    </> : <p>A workspace must be connected before you can link your own Slack account.</p>}
  </>;
}

/** Native Settings only: workspace consent and proof of the current person's Slack identity. */
export function SlackConnection() {
  const [status, setStatus] = useState<SlackStatus>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function load() {
    try {
      const next: SlackStatus = await call('chat/slack');
      setStatus(next); setError('');
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => {
    let current = true;
    call('chat/slack').then((next: SlackStatus) => { if (current) setStatus(next); }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, []);
  async function changed(message: string) { setNotice(message); await load(); }
  return <Section title="Slack questions and replies" label="Slack questions and replies">
    <div style={{ fontSize: 14, overflowWrap: 'anywhere' }}>
      <p className="muted">Answer claim questions in a private Slack thread. Manage the workspace connection and your own account link here.</p>
      <p role="status" aria-live="polite">{notice}</p>
      {error && <p className="form-error" role="alert">{error} <button type="button" className="button small" onClick={load}>Reload Slack status</button></p>}
      {!status && !error && <p role="status">Loading Slack connection…</p>}
      {status && <>
        <p>{status.connected ? <>Connected to <strong>{status.workspace ?? 'Slack'}</strong>.</> : 'No Slack workspace connected.'}</p>
        {!status.connected && !status.canConnect && <p>An owner, admin or finance member can connect the Slack workspace.</p>}
        <WorkspaceConnection status={status} changed={changed} />
        <PersonalLink status={status} changed={changed} />
      </>}
    </div>
  </Section>;
}
