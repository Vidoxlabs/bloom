import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startDemo } from './network.mjs';

test('a person can brief a team, open its reviewed file and return on a phone', async t => {
  const { link } = await startDemo(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  await page.goto(link);
  await page.getByRole('heading',{name:'What should we work on?',exact:true}).waitFor();
  await page.getByRole('button',{name:'Create a coding session',exact:true}).click();
  assert.equal(await page.locator('#kind').inputValue(),'direct');
  assert.equal(await page.locator('#create-session').innerText(),'Create coding session');
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Create a team',exact:true}).click();
  assert.equal(await page.locator('#kind').inputValue(),'team');
  for (const [label, hint] of [['Head agent name','Plans the work and assigns it to specialists.'],['Jurisdiction','What this agent is responsible for.']]) {
    assert.equal(await page.locator('#session-form').getByLabel(label,{exact:true}).evaluate(field => document.getElementById(field.getAttribute('aria-describedby')).textContent),hint);
  }
  await page.getByLabel('Head agent name',{exact:true}).fill('Desk lead');
  await page.getByRole('button',{name:'Create team',exact:true}).click();
  assert.equal(await page.locator('#session-path').isHidden(),true);
  await page.getByRole('heading',{name:'Shared desktop',exact:true}).waitFor();
  await page.getByText('Files every agent on this computer can open and reuse.').waitFor();
  assert.match(await page.locator('#members summary').first().innerText(),/^Desk lead · Head agent$/);
  await page.getByRole('button',{name:'Add file',exact:true}).click();
  const sourceTitle = 'Field notebook — observations from the first four greenhouse samples';
  await page.getByLabel('Title',{exact:true}).fill(sourceTitle);
  await page.getByLabel('Or paste text').fill('Four samples were collected.');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('button',{name:'Try a sample task',exact:true}).click();
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.getByRole('button',{name:/Open Assembler/}).click();
  await page.locator('#reader[open]').waitFor();
  assert.match(await page.locator('#reader-body').innerText(),/Field notebook/);
  await page.getByRole('dialog').getByRole('button',{name:sourceTitle,exact:true}).click();
  await page.getByRole('heading',{name:sourceTitle,exact:true}).waitFor();
  assert.equal(await page.locator('#reader-body').innerText(),'Four samples were collected.');
  await page.getByRole('button',{name:'Close',exact:true}).last().click();
  await page.reload();
  await page.getByRole('button',{name:'Open Assembler · Reviewed guide',exact:true}).waitFor();
  assert.match(await page.locator('#usage summary').innerText(), /4\/6 model calls · tokens unreported/);
  assert.equal(await page.locator('#usage-heading').isVisible(),true);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('16px Geist')),true);
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
    const actionLines = await page.locator('#files .text-button').evaluateAll(buttons => buttons.map(button => {
      const label = document.createRange();
      label.selectNodeContents(button);
      return label.getClientRects().length;
    }));
    assert.deepEqual(actionLines, [1, 1, 1, 1], 'Each Open action fits on one line beside its filename');
    const contrast = await page.evaluate(() => {
      function luminance(rgb) {
        const parts = rgb.match(/[\d.]+/g).slice(0,3).map(v => Number(v)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
        return .2126*parts[0]+.7152*parts[1]+.0722*parts[2];
      }
      const root = getComputedStyle(document.documentElement);
      const button = getComputedStyle(document.querySelector('#send'));
      const hint = getComputedStyle(document.querySelector('.hint'));
      const rail = getComputedStyle(document.querySelector('.activity'));
      return [(luminance(button.color)+.05)/(luminance(button.backgroundColor)+.05),
        (luminance(hint.color)+.05)/(luminance(rail.backgroundColor)+.05), root.fontFamily.startsWith('Geist')];
    });
    assert.ok(contrast[0] >= 4.5 && contrast[1] >= 4.5 && contrast[2]);
    if (process.env.BLOOM_UI_EVIDENCE) {
      mkdirSync(process.env.BLOOM_UI_EVIDENCE,{recursive:true});
      await page.screenshot({path:join(process.env.BLOOM_UI_EVIDENCE,'team-'+width+'.png'),fullPage:true});
    }
  }
  await page.setViewportSize({width:1440,height:900});
  assert.deepEqual(await page.locator('#files .folder').allInnerTexts(), ['Guides','Research']);
  await page.locator('#files li', {hasText:'Assembler · Reviewed guide'}).getByRole('checkbox').check();
  await page.getByLabel('Message').fill('Tighten the guide.');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.getByText('I revised the guide; the earlier version stays in its history.').waitFor();
  const revisedRow = page.locator('#files li', {hasText:'Assembler · Reviewed guide'});
  assert.equal(await revisedRow.count(), 1, 'the desktop lists only the newest revision');
  assert.match(await revisedRow.innerText(), /v2/);
  await revisedRow.getByRole('button',{name:'Open',exact:true}).click();
  await page.locator('#reader[open]').waitFor();
  assert.match(await page.locator('#reader-lineage').innerText(), /Guides · Revision 2/);
  await page.getByRole('button',{name:/^Revision 1 · Assembler · Reviewed guide/}).click();
  await page.locator('#reader-lineage').filter({hasText:'Guides · Revision 1'}).waitFor();
  if (process.env.BLOOM_UI_EVIDENCE) await page.screenshot({path:join(process.env.BLOOM_UI_EVIDENCE,'revision-history.png')});
  await page.getByRole('button',{name:'Close',exact:true}).last().click();

  // Persona library: save a specialist once, and any head agent can recruit it.
  const library = page.getByRole('region',{name:'Personas'});
  await library.getByText('Saved specialists any head agent can recruit by name.').waitFor();
  await library.getByRole('button',{name:'+ New',exact:true}).click();
  const personaForm = page.locator('#persona-dialog[open]');
  await personaForm.getByRole('heading',{name:'New persona',exact:true}).waitFor();
  assert.equal(await personaForm.getByLabel('Model',{exact:true}).evaluate(field => document.getElementById(field.getAttribute('aria-describedby')).textContent),"Leave blank to use the team's model.");
  await personaForm.getByLabel('Name',{exact:true}).fill('Iris');
  await personaForm.getByLabel('Jurisdiction',{exact:true}).fill('Find primary sources and quote them exactly.');
  await personaForm.getByLabel('Voice',{exact:true}).fill('Curious and exact.');
  await personaForm.getByRole('combobox',{name:/^Stage/}).selectOption('research');
  await personaForm.getByRole('button',{name:'Save',exact:true}).click();
  await library.getByText('Iris · Research',{exact:true}).waitFor();
  await page.getByLabel('Message').fill('Research the notebook again.');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.getByText('I assigned three steps and recruited Iris from the persona library.').waitFor();
  await page.locator('#members summary',{hasText:/^Iris · Research$/}).waitFor();
  const reviewer = page.locator('#members details',{hasText:'Reviewer · Review'});
  await reviewer.locator('summary').click();
  await reviewer.getByRole('button',{name:'Save as persona',exact:true}).click();
  assert.equal(await personaForm.getByLabel('Name',{exact:true}).inputValue(),'Reviewer');
  assert.equal(await personaForm.getByRole('combobox',{name:/^Stage/}).inputValue(),'review');
  await personaForm.getByRole('button',{name:'Save',exact:true}).click();
  await library.getByText('Reviewer · Review',{exact:true}).waitFor();

  await page.locator('#new-session').click();
  await page.getByLabel('Head agent name',{exact:true}).fill('Second desk');
  await page.getByRole('button',{name:'Create team',exact:true}).click();
  await page.getByRole('heading',{name:'Second desk',exact:true}).waitFor();
  await library.getByRole('button',{name:'Add Reviewer to team',exact:true}).click();
  await page.locator('#members summary',{hasText:/^Reviewer · Review$/}).waitFor();
  await library.getByRole('button',{name:'Edit Iris',exact:true}).click();
  await personaForm.getByRole('heading',{name:'Edit Iris',exact:true}).waitFor();
  page.once('dialog',dialog => dialog.accept());
  await personaForm.getByRole('button',{name:'Delete',exact:true}).click();
  await library.getByText('Iris · Research',{exact:true}).waitFor({state:'detached'});
  if (process.env.BLOOM_UI_EVIDENCE) await page.screenshot({path:join(process.env.BLOOM_UI_EVIDENCE,'persona-library.png')});

  // Team memory: rules always apply, facts only when relevant, agent suggestions wait for Keep.
  await page.getByRole('button',{name:'Add note',exact:true}).click();
  const noteForm = page.locator('#editor[open]');
  assert.equal(await noteForm.getByLabel('Always use').isChecked(),true);
  assert.equal(await noteForm.getByLabel('Always use').evaluate(field => document.getElementById(field.getAttribute('aria-describedby')).textContent),'Turn off to use this note only when it matches the task.');
  await page.getByLabel('What should this team remember?').fill('Write in British English.');
  await noteForm.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('button',{name:'Add note',exact:true}).click();
  await page.getByLabel('What should this team remember?').fill('Invoices go to the finance inbox.');
  await noteForm.getByLabel('Always use').uncheck();
  await noteForm.getByRole('button',{name:'Save',exact:true}).click();
  await page.locator('#notes li',{hasText:'Invoices go to the finance inbox.'}).getByText('Used when relevant').waitFor();
  await page.locator('#files li',{hasText:sourceTitle}).getByRole('checkbox').check();
  await page.getByLabel('Message').fill('Summarise the greenhouse samples.');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  const used = page.locator('#tools details').first();
  await used.locator('summary',{hasText:/^Researcher · 1 of 2 notes used$/}).waitFor();
  await used.locator('summary').click();
  await used.getByText('Always · Write in British English.').waitFor();
  await page.getByRole('heading',{name:'Suggested by agents',exact:true}).waitFor();
  await page.getByText('Agents never use a suggestion until you keep it.').waitFor();
  await page.getByRole('button',{name:/^Keep suggestion: Field notebook/}).click();
  await page.locator('#notes li',{hasText:'is a source this team has worked from.'}).getByText(/Suggested by Researcher/).waitFor();
  assert.equal(await page.getByRole('heading',{name:'Suggested by agents'}).count(),0);
  await page.locator('#notes li',{hasText:'Write in British English.'}).getByRole('button',{name:'Correct',exact:true}).click();
  await noteForm.getByRole('heading',{name:'Correct a note',exact:true}).waitFor();
  await page.getByLabel('What should the team remember instead?').fill('Write in American English.');
  await noteForm.getByRole('button',{name:'Save',exact:true}).click();
  await page.locator('#notes li',{hasText:'Write in American English.'}).getByText('Always used · Corrected').waitFor();
  const forgottenNote = page.locator('#notes li',{hasText:'Invoices go to the finance inbox.'});
  await forgottenNote.getByRole('button',{name:'Forget',exact:true}).click();
  await forgottenNote.waitFor({state:'detached'});

  // Team to team: the second desk asks Desk lead a question and both conversations show it.
  await page.getByLabel('Message').fill('Ask Desk lead before starting.');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.locator('.is-crossteam',{hasText:'Question for Desk lead'}).waitFor();
  await page.locator('.is-crossteam',{hasText:'From team Desk lead'}).getByText(/^From our side:/).waitFor();
  await page.getByText('Turn ended').waitFor();
  await page.locator('#plan li',{hasText:'Desk lead · Answering'}).waitFor();
  if (process.env.BLOOM_UI_EVIDENCE) await page.screenshot({path:join(process.env.BLOOM_UI_EVIDENCE,'team-question.png')});
  await page.getByRole('button',{name:'Desk lead',exact:true}).click();
  await page.getByRole('heading',{name:'Desk lead',exact:true}).waitFor();
  await page.locator('.is-crossteam',{hasText:'From team Second desk'}).waitFor();
  await page.locator('.is-crossteam',{hasText:'Question for Second desk'}).waitFor();
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
  }
  assert.deepEqual(errors,[]);
});

// Bloom on a given port and data directory, so a restart is the same origin and the same sessions
// to a tab that stays open, as when a person restarts Bloom.
async function launchBloom(t, directory, port = 0) {
  const child = spawn(process.execPath, ['src/main.mjs','--demo','--port',String(port),'--data-dir',directory], { stdio:['ignore','pipe','pipe'] });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill();
    await closed;
  };
  t.after(stop);
  const link = await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Bloom listener timed out')), 8000);
    let log = '';
    child.stdout.on('data',chunk => {
      log += chunk;
      const found = log.match(/http:\/\/127\.0\.0\.1:\d+\/#launch=[\w-]+/)?.[0];
      if (found) { clearTimeout(timer); resolve(found); }
    });
    child.on('exit',code => {clearTimeout(timer); reject(new Error('Bloom listener exited: '+code));});
  });
  return { link, origin: new URL(link).origin, port: Number(new URL(link).port), stop };
}

test('a tab that already shows Bloom signs in and reconnects when it opens a new launch link', async t => {
  const directory = mkdtempSync(join(tmpdir(),'bloom-relaunch-'));
  t.after(() => rmSync(directory,{ recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  let bloom = await launchBloom(t, directory);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  const streams = new Set();
  page.on('request',request => { if (/\/events\?/.test(request.url())) streams.add(request); });
  for (const settled of ['requestfinished','requestfailed']) page.on(settled,request => streams.delete(request));
  // Opening a link in a tab that already shows Bloom changes only the fragment.
  const openLink = link => page.evaluate(hash => { location.hash = hash; }, new URL(link).hash);
  const connected = () => page.waitForFunction(() => document.getElementById('connection').textContent === ''
    && !document.getElementById('composer').hidden && document.getElementById('error').hidden, null, { timeout: 8000 });

  // A bookmarked tab at / is refused. Its refused first request is held until after the tab has
  // signed in from the link, so that late refusal must not sign the tab out again.
  let release;
  const refused = new Promise(resolve => { release = resolve; });
  await page.route('**/api/info', route => route.request().headers()['x-bloom-owner'] ? route.continue() : release(route));
  await page.goto(bloom.origin + '/');
  const late = await refused;
  await openLink(bloom.link);
  await page.locator('#runtime',{hasText:'Scripted demo'}).waitFor({ timeout: 8000 });
  await late.continue();
  await page.unroute('**/api/info');
  await page.getByRole('button',{name:'Create a team',exact:true}).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#runtime').innerText(),'Scripted demo');
  assert.equal(await page.locator('#error').isHidden(),true);

  await page.getByRole('button',{name:'Create a team',exact:true}).click();
  await page.getByLabel('Head agent name',{exact:true}).fill('Night desk');
  await page.getByRole('button',{name:'Create team',exact:true}).click();
  await page.getByRole('button',{name:'Try a sample task',exact:true}).click();
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.getByRole('button',{name:/Open Assembler/}).waitFor();
  await connected();
  const messages = await page.locator('#transcript article').count();
  assert.ok(messages > 0);

  // A restart signs the open tab out. The new link reconnects the same tab without a reload, once.
  await bloom.stop();
  bloom = await launchBloom(t, directory, bloom.port);
  await page.locator('#connection',{hasText:'Disconnected'}).waitFor({ timeout: 20000 });
  await openLink(bloom.link);
  await connected();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#transcript article').count(), messages, 'the reconnected stream replays each message once');
  assert.equal(await page.locator('#session-list button').count(), 1);
  assert.equal(streams.size, 1, 'one event stream is open');

  // The reconnected tab stays signed in across a reload.
  await page.reload();
  await page.getByRole('button',{name:/Open Assembler/}).waitFor();
  await connected();
  assert.deepEqual(errors,[]);
});
