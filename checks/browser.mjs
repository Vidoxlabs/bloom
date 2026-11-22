import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startDemo } from './network.mjs';

test('a person can brief a team, open its reviewed file and return on a phone', async t => {
  const host = await startDemo(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  await page.goto(host);
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
