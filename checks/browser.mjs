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
  await page.locator('#reader[open]').waitFor();
  assert.match(await page.locator('#reader-body').innerText(),/Field notebook/);
  await page.getByRole('dialog').getByRole('button',{name:'Field notebook',exact:true}).click();
  await page.getByRole('heading',{name:'Field notebook',exact:true}).waitFor();
  assert.equal(await page.locator('#reader-body').innerText(),'Four samples were collected.');
  await page.getByRole('button',{name:'Close',exact:true}).last().click();
  await page.reload();
  await page.getByRole('button',{name:/Open Assembler/}).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('16px Geist')),true);
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
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
  assert.deepEqual(errors,[]);
});
