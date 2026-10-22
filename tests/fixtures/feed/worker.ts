// Assemble production routes and scheduled services; only the issuer server is a test edge.
import { api } from '../../../src/coaster/api';
import { authResponse } from '../../../src/auth.server';
import { runHourly } from '../../../src/coaster/hourly';
import { programFeedApi, runProgramFeeds } from '../../../src/coaster/feeds';
import { databaseAtEdge } from '../../d1-edge';

api.route('/api/coaster/feeds', programFeedApi);
export default {
  async fetch(request: Request, original: any, ctx: ExecutionContext) {
    const env={...original,DB:databaseAtEdge(original)};
    return await authResponse(request,env)??api.fetch(request,env,ctx);
  },
  async scheduled(controller: ScheduledController,env:any) {
    const at=new Date(controller.scheduledTime);
    await runProgramFeeds(env,at);
    await runHourly(env,at);
  },
};
