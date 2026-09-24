import assert from 'node:assert/strict';
import { encryptMessage } from '../src/crypto.mjs';
import { writeTerminalFrame } from './terminal-frame.mjs';
// Called only by the isolated PowerShell/ConPTY test with synthetic accounts.
export async function exerciseInteraction({ child, enter, visible, waitFor, screen, bob, terminal, reportPrefix }) {
  enter('/ttl 1m'); await visible('后续文字保留 1m');
  child.write('命令回溯前的草稿'); await visible('命令回溯前的草稿');
  child.write('\x1b[A'); await visible('› /ttl 1m');
  child.write('\x1b[A'); await visible('› /chat bobby_tty');
  child.write('\x1b[B'); await visible('› /ttl 1m');
  child.write('\x1b[B'); await visible('› 命令回溯前的草稿');
  child.write('\x15'); enter('一分钟后自动清理的测试消息');
  await visible('一分钟后自动清理的测试消息');
  const label = () => screen().split('\n').find((line) => line.includes('一分钟后自动清理的测试消息'))?.match(/剩余 (\d{2}:\d{2}:\d{2})/)?.[1];
  await waitFor(() => Boolean(label()), 'countdown visible');
  const first = label();
  await waitFor(() => Boolean(label()) && label() !== first, 'countdown changes without new messages', 4000);
  enter('/help'); await visible('› /help · 仅本机');
  assert.ok(screen().includes('一分钟后自动清理的测试消息'), 'help leaves preceding chat visible');
  writeTerminalFrame(terminal, `test-results/${reportPrefix}-interaction-help.json`);
  await bob.send('帮助期间收到的消息'); await visible('有新消息');
  child.write('\x1b[1;5F'); await visible('帮助期间收到的消息');
  child.write('\x1b[1;5H'); await visible('你好，PowerShell！');
  child.write('\x1b[1;5F');
  const expiring = encryptMessage(bob.user, bob.selected.peer, bob.selected.id, '四秒倒计时测试', { ttlMs: 4000 });
  await bob.request(`/api/conversations/${bob.selected.id}/messages`, 'POST', expiring);
  await visible('四秒倒计时测试');
  await waitFor(() => !screen().includes('四秒倒计时测试'), 'expired message disappears from transcript', 7000);
  enter('/ttl 24h'); await visible('后续文字保留 24h');
}
