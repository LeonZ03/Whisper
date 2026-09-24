import { test, expect } from '@playwright/test';
import { cloudFixture } from './cloud-fixture.mjs';
import { WhisperClient } from '../cli/client.mjs';
let app;
test.beforeAll(async()=>{app=await cloudFixture();});
test.afterAll(async()=>{await app?.close();});
test('cloud Worker: real browser and CLI share encrypted messages and countdowns',async({browser})=>{
  const context=await browser.newContext(),page=await context.newPage();
  const bob=new WhisperClient({server:app.url});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',d=>d.accept());
  const password='Isolated-Cloud-Browser-Test!2026';
  try {
    await bob.authenticate({username:'cloud_bobby',password,invite:app.invite,register:true});
    await page.goto(app.url);await expect(page.locator('#auth-submit')).toBeEnabled();
    await page.locator('#register-tab').click();await page.locator('#username').fill('cloud_alice');
    await page.locator('#password').fill(password);await page.locator('#invite').fill(app.invite);
    await page.locator('#auth-submit').click();await expect(page.locator('#chat-screen')).toBeVisible({timeout:20000});
    await expect(page.locator('#entry-kind')).toHaveText('云端服务');
    await page.locator('#peer-name').fill('cloud_bobby');await page.getByRole('button',{name:'开始会话',exact:true}).click();
    await expect(page.locator('#peer-title')).toHaveText('cloud_bobby');
    await page.locator('#ttl').selectOption('60000');await page.locator('#message-input').fill('云端浏览器发给 CLI');
    await page.locator('#send').click();await expect(page.locator('.bubble').filter({hasText:'云端浏览器发给 CLI'})).toBeVisible();
    await bob.chat('cloud_alice');expect(bob.viewMessages()[0].text).toBe('云端浏览器发给 CLI');
    await bob.send('云端 CLI 回复浏览器');
    await expect(page.locator('.bubble').filter({hasText:'云端 CLI 回复浏览器'})).toBeVisible({timeout:12000});
    const own=page.locator('article').filter({hasText:'云端浏览器发给 CLI'});
    await expect(own.locator('.message-countdown')).toContainText('剩余');
    await page.locator('#message-input').fill('不应丢失的草稿');
    await page.waitForTimeout(1100);await expect(page.locator('#message-input')).toHaveValue('不应丢失的草稿');
    await page.locator('#verify').click();expect(await page.locator('#safety-code').innerText()).toBe(await bob.safety());
    await page.locator('#close-safety').click();
    await own.getByRole('button',{name:'双方删除',exact:true}).click();await bob.sync();
    expect(bob.viewMessages().some(m=>m.text==='云端浏览器发给 CLI')).toBe(false);
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  }finally{await bob.logout().catch(()=>{});await context.close();}
});
