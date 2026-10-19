import { runtimeBindings, type Bindings } from '../auth.server';
import { deliverReports } from './report-schedules';
import { runReminders } from './reminders';
import { runBudgets } from './budgets';
import { runAllowances } from './allowances';
import { runAutoSubmit } from './auto-reports';
import { runRetention } from './retention';
import { runPaySchedule } from './batches';

/** The hourly Cron Trigger: chases open items (FOLLOWUP-001), alerts budgets (REPORT-004), pays stipends and opens recurring
 * drafts (CLAIM-009), submits automatic reports on schedule (AUTO-001), proposes records past retention (RETAIN-001), sends
 * scheduled reports (REPORT-002) and opens the pay-day batch (PAY-004). */
export async function runHourly(original: Bindings, at: Date) {
  const env = runtimeBindings(original);
  await runReminders(env, at);
  await runBudgets(env, at);
  await runAllowances(env, at);
  await runAutoSubmit(env, at);
  await runRetention(env, at);
  await deliverReports(env, at);
  await runPaySchedule(env.DB, at);
}
