import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWhisperServer } from '../server/app.mjs';
import { prepareOwnerMaterial } from '../accounts/owner-material.mjs';

test('account approval browser flow: pending notice, forced root password change, approval and mobile admin layout', async ({ browser }) => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-accounts-browser-'));
  const app = await createWhisperServer({ dataDir: dir, port: 0 });
  const initialPassword = 'Root0!', nextPassword = 'Root1!', memberPassword = 'Member8!';
  const root = await prepareOwnerMaterial(initialPassword);
  const { row } = root;
  app.db.prepare(`INSERT INTO users(id,username,public_key,salt,vault_nonce,vault_cipher,auth_salt,auth_hash,auth_scheme,created_at,role,status,must_change,credential_version)
    VALUES(?,?,?,?,?,?,?,?,'root-bootstrap-hmac-v1',?,'root','active',1,1)`)
    .run(row.id, row.username, row.publicKey, row.salt, row.vault.nonce, row.vault.ciphertext, row.authSalt, row.authHash, Date.now());

  const applicantContext = await browser.newContext();
  const rootContext = await browser.newContext();
  const applicant = await applicantContext.newPage();
  const admin = await rootContext.newPage();
  const errors = [];
  for (const page of [applicant, admin]) page.on('pageerror', error => errors.push(error.message));
  try {
    await applicant.goto(app.localUrl);
    await expect(applicant.locator('#auth-submit')).toBeEnabled();
    await applicant.locator('#register-tab').click();
    await applicant.locator('#username').fill('approval_member');
    await applicant.locator('#password').fill(memberPassword);
    await applicant.locator('#request-note').fill('isolated browser approval regression');
    await applicant.locator('#auth-submit').click();
    await expect(applicant.locator('#toast')).toContainText('申请已提交');
    await applicant.locator('#username').fill('approval_member');
    await applicant.locator('#password').fill(memberPassword);
    await applicant.locator('#auth-submit').click();
    await expect(applicant.locator('#auth-error')).toContainText('等待管理员审批');

    await admin.goto(app.localUrl);
    await expect(admin.locator('#auth-submit')).toBeEnabled();
    await admin.locator('#username').fill('root');
    await admin.locator('#password').fill(initialPassword);
    await admin.locator('#activation-code').fill(root.activationCode);
    await admin.locator('#auth-submit').click();
    await expect(admin.locator('#password-dialog')).toBeVisible();
    await expect(admin.locator('#password-close')).toBeHidden();
    await admin.locator('#old-password').fill(initialPassword);
    await admin.locator('#new-password').fill(nextPassword);
    await admin.locator('#repeat-password').fill(nextPassword);
    await admin.locator('#password-submit').click();
    await expect(admin.locator('#auth-screen')).toBeVisible();

    await admin.locator('#username').fill('root');
    await admin.locator('#password').fill(nextPassword);
    await admin.locator('#auth-submit').click();
    await expect(admin.locator('#admin-panel')).toBeVisible();
    const member = admin.locator('.member-card').filter({ hasText: 'approval_member' });
    await expect(member.locator('.member-status')).toHaveText('等待审批');

    await admin.setViewportSize({ width: 390, height: 844 });
    await expect(admin.locator('#admin-panel')).toBeVisible();
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await member.locator('[data-action="approve"]').click();
    await admin.locator('#member-confirm-name').fill('approval_member');
    await admin.locator('#admin-password').fill(nextPassword);
    await admin.locator('#member-action-submit').click();
    await expect(member.locator('.member-status')).toHaveText('已批准');

    await applicant.locator('#password').fill(memberPassword);
    await applicant.locator('#auth-submit').click();
    await expect(applicant.locator('#chat-screen')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await applicantContext.close(); await rootContext.close();
    await app.close(); rmSync(dir, { recursive: true, force: true });
  }
});
