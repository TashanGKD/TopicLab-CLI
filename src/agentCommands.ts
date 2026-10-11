import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import { Command } from 'commander';
import { SessionManager } from './session.js';
import { StateStore } from './config.js';
import { TopicLabCLIError } from './errors.js';
import { TopicLabHTTPClient } from './http.js';

type Options = {json?: boolean; limit?: string; cursor?: string; status?: string; scene?: string; offset?: string; file?: string; timeout?: string; tokenFile?: string; baseUrl?: string};
function bodyFile(file?: string): Record<string, unknown> {
  if (!file) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TopicLabCLIError('Expected JSON object in --file');
  return parsed as Record<string, unknown>;
}
export function registerAgentCommands(program: Command, session: SessionManager, store: StateStore,
  emit: (payload: any, json: boolean) => number) {
  const output = (payload: any, options: Options) => { process.exitCode = emit(payload, options.json ?? false); };
  const idPath = (id: string) => `/api/v1/topiclink/agent-tasks/${encodeURIComponent(id)}`;
  const tasks = program.command('tasks').description('Read, claim, renew and report assigned tasks');
  tasks.command('list').option('--status <status>', 'pending, claimed, replied or failed', 'pending').option('--limit <n>', '', '50').option('--cursor <cursor>').option('--json')
    .action(async (o: Options) => output(await session.requestWithAutoRenew('GET', '/api/v1/topiclink/agent-tasks', {params:{status:o.status,limit:o.limit,cursor:o.cursor}}), o));
  tasks.command('get <task_id>').option('--json').action(async (id: string, o: Options) => output(await session.requestWithAutoRenew('GET',idPath(id)),o));
  for (const action of ['claim','renew','complete','fail']) {
    tasks.command(`${action} <task_id>`).option('--file <path>', 'Result or failure JSON').option('--json').action(async (id: string,o: Options) => {
      const state = store.load();
      let token = state.task_claims?.[id];
      if(action === 'claim' && !token) {
        token = randomBytes(32).toString('base64url');
        state.task_claims = {...state.task_claims, [id]:token};
        // Keep the proof before sending: a lost response must not lose claim ownership.
        store.save(state);
      }
      if (action !== 'claim' && !token) throw new TopicLabCLIError('No locally saved claim proof. Read the task and claim it before reporting.', {code:'missing_claim_proof'});
      const result = await session.requestWithAutoRenew('POST',`${idPath(id)}/${action}`,{jsonBody:{...bodyFile(o.file), ...(token ? {claim_token:token} : {})}}) as Record<string,unknown>;
      if (typeof result.claim_token === 'string') {
        state.task_claims = {...state.task_claims,[id]:result.claim_token}; store.save(state);
        delete result.claim_token;
        result.claim_proof_saved = true;
      }
      output(result,o);
    });
  }
  const discussion = program.commands.find(c => c.name() === 'discussion')!;
  for (const action of ['status','cancel']) discussion.command(`${action} <topic_id>`).option('--json').action(async (id:string,o:Options) => output(await session.requestWithAutoRenew(action === 'cancel' ? 'POST' : 'GET',`/api/v1/topics/${encodeURIComponent(id)}/discussion/${action}`, action === 'cancel' ? {jsonBody:{}} : {}),o));
  discussion.command('wait <topic_id>').option('--timeout <seconds>','Maximum wait duration','300').option('--json').action(async(id:string,o:Options)=>{
    const seconds=Number(o.timeout); if(!Number.isFinite(seconds)||seconds<1||seconds>3600) throw new TopicLabCLIError('Wait timeout must be 1–3600 seconds');
    const deadline=Date.now()+seconds*1000;
    while(Date.now()<deadline){
      const result=await session.requestWithAutoRenew('GET',`/api/v1/topics/${encodeURIComponent(id)}/discussion/status`) as Record<string,unknown>;
      if(result.status !== 'running') {output(result,o);return;}
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    throw new TopicLabCLIError('Run is still active. Query status to continue; do not restart it.',{code:'wait_timeout',detail:{retryable:false}});
  });
  const runs=program.command('runs');
  for(const action of ['get','result']) runs.command(`${action} <run_id>`).option('--json').action(async(id:string,o:Options)=>output(await session.requestWithAutoRenew('GET',`/api/v1/agents/runs/${encodeURIComponent(id)}${action==='result'?'/result':''}`),o));
  const world=program.command('world');
  for(const [action,url] of [['signals','/api/v1/world/signals'],['questions','/api/v1/world/livebench/questions']] as const)
    world.command(action).option('--scene <scene>','World scene','global').option('--limit <n>','','20').option('--offset <n>','','0').option('--json').action(async(o:Options)=>output(await session.requestWithAutoRenew('GET',url,{params:{scene:o.scene,limit:o.limit,offset:o.offset}}),o));
  world.command('recall <query>').option('--scene <scene>','World scene','global').option('--limit <n>','','10').option('--json').action(async(query:string,o:Options)=>output(await session.requestWithAutoRenew('GET','/api/v1/world/source-knowledge/recall',{params:{query,scene:o.scene,limit:o.limit}}),o));
  world.command('vote').requiredOption('--file <path>').option('--json').action(async(o:Options)=>output(await session.requestWithAutoRenew('POST','/api/v1/world/livebench/vote',{jsonBody:bodyFile(o.file)}),o));
  const research=program.command('research');
  research.command('sources').option('--limit <n>','','20').option('--offset <n>','','0').option('--json').action(async(o:Options)=>output(await session.requestWithAutoRenew('GET','/api/v1/source-feed/articles',{params:{limit:o.limit,offset:o.offset}}),o));
  research.command('source <article_id>').option('--json').action(async(id:string,o:Options)=>output(await session.requestWithAutoRenew('GET',`/api/v1/source-feed/articles/${encodeURIComponent(id)}`),o));
  research.command('papers <title>').option('--limit <n>','','10').option('--json').action(async(title:string,o:Options)=>output(await session.requestWithAutoRenew('GET','/api/v1/aminer/paper/search',{params:{title,size:o.limit}}),o));
  research.command('recent').option('--limit <n>','','20').option('--offset <n>','','0').option('--json').action(async(o:Options)=>output(await session.requestWithAutoRenew('GET','/api/v1/literature/recent',{params:{limit:o.limit,offset:o.offset}}),o));
  const sessionCommands=program.commands.find(c=>c.name()==='session')!;
  sessionCommands.command('token').requiredOption('--token-file <path>').requiredOption('--base-url <url>').option('--json').action(async(o:Options)=>{
    const token=fs.readFileSync(o.tokenFile!,'utf8').trim(); if(!token) throw new TopicLabCLIError('Credential file is empty');
    const client=new TopicLabHTTPClient(o.baseUrl!,token); const actor=await client.requestJson('GET','/api/v1/agents/me') as Record<string,unknown>;
    const state=store.load(); state.base_url=o.baseUrl!; state.access_token=token;state.bind_key=null;state.agent_uid=String(actor.agent_uid);store.save(state);
    output({ok:true,agent_uid:state.agent_uid},o);
  });
  sessionCommands.command('join <invitation_url>').option('--json').action(async(raw:string,o:Options)=>{
    const url=new URL(raw);if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw new TopicLabCLIError('Invitation URL must use HTTPS');
    const invitation=url.searchParams.get('invitation');if(!invitation)throw new TopicLabCLIError('Invitation URL is missing invitation');
    const prefix=url.pathname.split('/api/v1/agents/')[0];const base=url.origin+prefix;
    const result=await new TopicLabHTTPClient(base).requestJson('POST','/api/v1/agents/invitations/redeem',{jsonBody:{invitation}}) as Record<string,unknown>;
    const state=store.load();state.base_url=base;state.access_token=String(result.access_token);state.bind_key=null;state.agent_uid=String(result.agent_uid);store.save(state);
    output({ok:true,agent_uid:state.agent_uid,expires_at:result.expires_at,scopes:result.scopes},o);
  });
}
