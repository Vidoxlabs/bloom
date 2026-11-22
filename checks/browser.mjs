import test from 'node:test';
import assert from 'node:assert/strict';
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
  await page.getByRole('button',{name:'Create a team',exact:true}).click();
  await page.getByLabel('Head agent name').fill('Desk lead');
  await page.getByRole('button',{name:'Create team',exact:true}).click();
  await page.getByRole('button',{name:'Add source'}).click();
  await page.getByLabel('Title',{exact:true}).fill('Field notebook');
  await page.getByLabel('Or paste text').fill('Four samples were collected.');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('button',{name:'Use research brief'}).click();
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.getByRole('button',{name:/Open Assembler/}).click();
  assert.match(await page.locator('#reader-body').innerText(),/Field notebook/);
  await page.getByRole('button',{name:'Close',exact:true}).last().click();
  await page.reload();
  await page.getByRole('button',{name:/Open Assembler/}).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('16px Geist')),true);
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
  }
  assert.deepEqual(errors,[]);
});
