import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Command} from 'commander';
import {afterEach,expect,it,vi} from 'vitest';
import {StateStore,defaultState} from '../src/config.js';
import {SessionManager} from '../src/session.js';
import {TopicLabCLIError} from '../src/errors.js';
import {TopicLabHTTPClient} from '../src/http.js';
import {registerAgentCommands} from '../src/agentCommands.js';
const homes:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();for(const home of homes)fs.rmSync(home,{recursive:true,force:true});process.exitCode=0;});
function fixture(){const home=fs.mkdtempSync(path.join(os.tmpdir(),'agent-cli-'));homes.push(home);const store=new StateStore(home);store.save({...defaultState(),base_url:'https://world.test',access_token:'tlag_fake'});const session=new SessionManager(store);const program=new Command();program.command('discussion');program.command('session');const output:any[]=[];registerAgentCommands(program,session,store,(result)=>{output.push(result);return 0;});return{program,store,session,output};}
it('claim proof is private and is reused for completion',async()=>{
 const {program,session,store,output}=fixture();
 const call=vi.spyOn(session,'requestWithAutoRenew').mockResolvedValueOnce({task:{id:'task-one'},claim_token:'private-proof'}).mockResolvedValueOnce({task:{status:'replied'}});
 await program.parseAsync(['node','topiclab','tasks','claim','task-one','--json']);
 expect(output[0].claim_token).toBeUndefined();expect(store.load().task_claims?.['task-one']).toBe('private-proof');
 const file=path.join(store.home,'result.json');fs.writeFileSync(file,JSON.stringify({summary:'Done'}));
 await program.parseAsync(['node','topiclab','tasks','complete','task-one','--file',file,'--json']);
 expect(call.mock.calls[1][2]?.jsonBody).toMatchObject({summary:'Done',claim_token:'private-proof'});
 expect(fs.statSync(store.statePath).mode&0o777).toBe(0o600);
});
it('external credentials work without legacy binding and do not silently switch identity',async()=>{
 const {session}=fixture();expect((await session.authedClient()).accessToken).toBe('tlag_fake');
 vi.spyOn(TopicLabHTTPClient.prototype,'requestJson').mockRejectedValue(new TopicLabCLIError('expired',{statusCode:401}));
 const renew=vi.spyOn(session,'ensureSession');
 await expect(session.requestWithAutoRenew('GET','/private')).rejects.toMatchObject({code:'credential_refresh_required'});
 expect(renew).not.toHaveBeenCalled();
});
it('reads retry transient failures but writes are sent once',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(new Response('{}',{status:503,headers:{'Retry-After':'0'}})).mockResolvedValueOnce(new Response('{"ok":true}'));
 vi.stubGlobal('fetch',fetch);const client=new TopicLabHTTPClient('https://world.test');
 expect(await client.requestJson('GET','/read')).toEqual({ok:true});expect(fetch).toHaveBeenCalledTimes(2);
 fetch.mockReset().mockResolvedValue(new Response('{"detail":{"code":"write_outcome_unknown","retryable":false}}',{status:503,headers:{'X-Request-ID':'req-123456'}}));
 try{await client.requestJson('POST','/write',{jsonBody:{}});throw new Error('Expected failure');}catch(error:any){expect(error.toPayload().error).toMatchObject({code:'write_outcome_unknown',request_id:'req-123456',retryable:false});}
 expect(fetch).toHaveBeenCalledTimes(1);
});
