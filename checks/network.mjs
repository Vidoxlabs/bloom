import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function startDemo(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bloom-live-'));
  const child = spawn(process.execPath, ['src/main.mjs','--demo','--port','0','--data-dir',directory], { stdio:['ignore','pipe','pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'close');
      child.kill();
      await stopped;
    }
    rmSync(directory,{recursive:true,force:true,maxRetries:4,retryDelay:100});
  });
  const url = await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Bloom listener timed out')),8000);
    let log = '';
    child.stdout.on('data',chunk => {
      log += chunk;
      const link = log.match(/(http:\/\/127\.0\.0\.1:\d+)\/#launch=[\w-]+/);
      if (link) { clearTimeout(timer); resolve({ host: link[1], link: link[0] }); }
    });
    child.on('exit',code => {clearTimeout(timer); reject(new Error('Bloom listener exited: '+code));});
  });
  return url;
}

// Trade the printed one-time code for the owner credential, as the page does. The credential
// comes back in the JSON body and is sent as the x-bloom-owner header; no cookie is involved.
export async function signIn({ host, link }) {
  const res = await fetch(host + '/api/launch', { method:'POST', headers:{'content-type':'application/json', origin:host}, body:JSON.stringify({ code: new URL(link).hash.slice('#launch='.length) }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  return { 'x-bloom-owner': (await res.json()).credential };
}

test('a downloadable checkout serves a complete team run and Markdown over HTTP', async t => {
  const demo = await startDemo(t);
  const { host } = demo;
  const owner = await signIn(demo);
  const post = async (path, body) => {
    const res = await fetch(host + path, { method:'POST', headers:{'content-type':'application/json', ...owner},body:JSON.stringify(body) });
    assert.ok(res.ok, String(res.status)); return res.json();
  };
  const room = await post('/api/teams',{name:'Field lead'});
  const path = '/api/teams/' + room.id;
  const source = await post(path + '/sources',{title:'Notebook',text:'Field samples: 4'});
  await post('/api/sessions/' + room.id + '/turns',{text:'Create a reviewed guide',files:[source.id]});
  let state;
  for (let i=0;i<120;i++) {
    state = await (await fetch(host+path,{headers:owner})).json();
    if (state.files.length === 4) break;
    await delay(50);
  }
  assert.deepEqual(state.members.map(m => m.name),['Researcher','Reviewer','Assembler']);
  const result = state.files.find(f => f.author === 'Assembler');
  assert.ok(result);
  const res = await fetch(host+path+'/files/'+result.id+'?download',{headers:owner});
  assert.equal(res.status,200); assert.match(res.headers.get('content-disposition'),/attachment/);
  assert.match(await res.text(),/Notebook/);
});
