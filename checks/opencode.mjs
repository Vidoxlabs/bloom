import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Harness } from '../src/harness.mjs';
import { Store } from '../src/store.mjs';
import { createHandler } from '../src/http.mjs';
import { createServerProvider } from '../src/models.mjs';

// A real OpenCode executable calls a local recording model. No paid provider or daily profile is used.
test('OpenCode 1.x accepts Bloom sessions and returns text and usage from a local model', {timeout:95_000}, async t => {
  const seen = [];
  let stage = 'start fixture';
  const model = createServer(async (req,res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    const body = JSON.parse(Buffer.concat(parts));
    seen.push(body); t.diagnostic('Recording model received a generation.');
    const context = body.messages.flatMap(m => typeof m.content === 'string' ? [m.content] : (m.content ?? []).map(p => p.text ?? '')).join('\n');
    let answer = { message: 'Reviewed.', title: 'Notes', document: 'Four samples.' };
    if (context.includes('You coordinate a group.')) {
      answer = {message:'Three owners for this brief.',agents:[
        {name:'Archivist',charter:'Extract the sample identifier.',stage:'research',assignment:'Read the notebook.'},
        {name:'Auditor',charter:'Check source evidence.',stage:'review',assignment:'Check the identifier.'},
        {name:'Editor',charter:'Assemble a guide.',stage:'assemble',assignment:'Write the approved guide.'},
      ]};
    } else if (context.includes('You are a specialist')) {
      if (context.includes('"stage":"research"') && context.includes('FIELD-041')) answer = {message:'Located the field entry.',title:'Finding',document:'Archivist verified FIELD-041.'};
      else if (context.includes('"stage":"review"') && context.includes('Archivist verified FIELD-041.')) answer = {message:'Source agrees.',title:'Review',document:'Auditor accepted FIELD-041.',verdict:'approve'};
      else if (context.includes('"stage":"assemble"') && context.includes('Auditor accepted FIELD-041.')) answer = {message:'Guide ready.',title:'Sample guide',document:'The reviewed identifier is FIELD-041.'};
      else answer = {message:'Missing upstream evidence.',title:'Hold',document:'The handoff is incomplete.',verdict:'revise'};
    }
    const base = {id:'chatcmpl-bloom-fixture',created:1,model:'review',object:'chat.completion.chunk'};
    if (!body.stream) {
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({...base,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:JSON.stringify(answer)},finish_reason:'stop'}],usage:{prompt_tokens:24,completion_tokens:9,total_tokens:33}})); return;
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk = (choices,usage) => res.write('data: '+JSON.stringify({...base,choices,usage})+'\n\n');
    chunk([{index:0,delta:{role:'assistant',content:JSON.stringify(answer)},finish_reason:null}]);
    chunk([{index:0,delta:{},finish_reason:'stop'}],{prompt_tokens:24,completion_tokens:9,total_tokens:33});
    res.end('data: [DONE]\n\n');
  });
  model.listen(0,'127.0.0.1'); await once(model,'listening');
  t.after(() => { model.closeAllConnections(); model.close(); });
  const host = 'http://127.0.0.1:' + model.address().port;
  const probe = createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const root = mkdtempSync(join(tmpdir(),'bloom-opencode-'));
  const cwd = join(root,'work'); mkdirSync(cwd);
  const config = { model:'fixture/review', small_model:'fixture/review', provider:{ fixture:{
    npm:'@ai-sdk/openai-compatible',name:'Recording model',options:{baseURL:host+'/v1',apiKey:'local-fixture'},
    models:{review:{name:'Review',limit:{context:16384,output:2048}}} } } };
  const env = {PATH:process.env.PATH, HOME:root, XDG_DATA_HOME:join(root,'data'),XDG_CONFIG_HOME:join(root,'config'),
    XDG_CACHE_HOME:join(root,'cache'), XDG_STATE_HOME:join(root,'state'), OPENCODE_CONFIG_CONTENT:JSON.stringify(config),
    OPENCODE_DISABLE_EXTERNAL_SKILLS:'1',OPENCODE_DISABLE_LSP_DOWNLOAD:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_DEFAULT_PLUGINS:'1'};
  const command = process.env.BLOOM_OPENCODE_BIN || 'opencode';
  const child = spawn(command,['serve','--print-logs','--hostname','127.0.0.1','--port',String(port)],{cwd,env,stdio:['ignore','pipe','pipe']});
  let log = '';
  for (const stream of [child.stdout,child.stderr]) stream.on('data',chunk => {log=(log+chunk.toString()).slice(-6500);});
  t.after(() => {
    if (stage !== 'finished') t.diagnostic('Last stage: ' + stage + '; recording-model calls: ' + seen.length + '\n' + log.replaceAll(root,'[fixture]'));
  });
  let launchError;
  child.on('error',e => { launchError = e; });
  t.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child,'close');
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'),3000);
      await stopped; clearTimeout(kill);
    }
    rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  });
  const baseURL = 'http://127.0.0.1:' + port;
  stage = 'waiting for /global/health';
  let ready = false;
  for (let i=0; i<160; i++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error('OpenCode exited during startup with '+child.exitCode);
    try { ready = (await (await fetch(baseURL+'/global/health',{signal:AbortSignal.timeout(750)})).json()).healthy === true; } catch {}
    if (ready) break;
    await delay(150);
  }
  assert.equal(ready,true,'OpenCode must be healthy');
  stage = 'generating via OpenCode';
  const provider = createServerProvider({baseURL,fetcher:async (url,options) => {
    stage = 'OpenCode ' + options.method + ' ' + new URL(url).pathname;
    const res = await fetch(url,options); t.diagnostic(stage + ' returned ' + res.status);
    return res;
  }});
  const result = await provider.generate({system:'Report four samples in JSON.',prompt:'Summarize the sample count.',
    model:'fixture/review',signal:AbortSignal.timeout(55_000)});
  assert.equal(result.complete,true);
  assert.equal(JSON.parse(result.text).document,'Four samples.');
  assert.equal(result.usage.total,33);
  assert.ok(seen.some(r => JSON.stringify(r.messages).includes('Summarize the sample count.')));
  stage = 'end-to-end OpenCode team run';
  const dataDirectory = join(root,'bloom');
  const store = new Store(dataDirectory);
  const harness = new Harness({store,dataDirectory,adapters:[],teamProvider:provider});
  const server = createServer(createHandler(harness));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await harness.close(); store.close(); });
  const local = 'http://127.0.0.1:'+server.address().port;
  const post = async (path,value) => {
    const res = await fetch(local+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
    assert.ok(res.ok,'POST '+path+' returned '+res.status); return res.json();
  };
  const team = await post('/api/teams',{name:'Field lead',model:'fixture/review'});
  const source = await post('/api/teams/'+team.id+'/sources',{title:'Field notebook',text:'Identifier FIELD-041'});
  await post('/api/sessions/'+team.id+'/turns',{text:'Write and review a short field guide.',files:[source.id]});
  await harness.active.get(team.id)?.task;
  const events = store.eventsAfter(team.id,0);
  assert.equal(events.at(-1).data.status,'finished',JSON.stringify(events.at(-1)));
  const posts = events.filter(e => e.type === 'team.message');
  assert.deepEqual(posts.map(e => e.data.author),['Field lead','Archivist','Auditor','Editor']);
  const usage = events.filter(e => e.type === 'team.usage');
  assert.equal(usage.length,4); assert.equal(usage.at(-1).data.measuredTotal,132);
  const final = await (await fetch(local+'/api/teams/'+team.id+'/files/'+posts.at(-1).data.file.id)).json();
  assert.equal(final.text,'The reviewed identifier is FIELD-041.'); assert.equal(final.parents.length,3);
  t.diagnostic('Verified four OpenCode-backed roles, four usage records and three source links.');
  stage = 'finished';
});
