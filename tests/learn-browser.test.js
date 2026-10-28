/**
 * 专用浏览器控制器测试（零依赖、不联网、不起进程）
 * 运行：node tests/learn-browser.test.js
 *
 * 为什么要测这一层：自动续期是「没人看着也要对」的逻辑。真机验收只能证明
 * 「今天这台机器上能用」，而课堂号、Cookie 域、超时这些边界都得靠假对象钉死。
 * 所有副作用都在方法里发生，所以构造对象本身可以随便造，测试不惊动系统。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEARN_HOST,
  LEARN_LOGIN_PATH,
  LEARN_INDEX_PATH,
  LEARN_BROWSER_PORT,
  SSO_HOST,
  edgeCandidates,
  findEdgeExecutable,
  ssoUrlFromLoginHtml,
  cookiesToHeader,
  createCdpClient,
  createLearnBrowser,
} from '../lib/learn-browser.js';

/** 一个只够用的假 WebSocket：能收能发、能手动喂消息。 */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    FakeSocket.last = this;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  close() {
    this.closed = true;
  }

  /** 模拟浏览器回一条 CDP 消息。 */
  reply(payload) {
    this.emit('message', { data: JSON.stringify(payload) });
  }
}

const silentLogger = { info() {}, warn() {}, error() {} };

test('常量：主机名与路径是学堂的那几个', () => {
  assert.equal(LEARN_HOST, 'learn.tsinghua.edu.cn');
  assert.equal(LEARN_LOGIN_PATH, '/f/login');
  assert.equal(LEARN_INDEX_PATH, '/f/wlxt/index/course/student/');
  assert.equal(LEARN_BROWSER_PORT, 9333);
  assert.equal(SSO_HOST, 'id.tsinghua.edu.cn');
});

test('edgeCandidates：先 Program Files (x86)，没有 LOCALAPPDATA 时只给两条',
  { skip: process.platform !== 'win32' && 'Edge 安装路径是 Windows 专有语义，其他平台跳过' }, () => {
  const withLocal = edgeCandidates({ 'ProgramFiles(x86)': 'C:\\pf86', ProgramFiles: 'C:\\pf', LOCALAPPDATA: 'C:\\local' });
  assert.deepEqual(withLocal, [
    'C:\\pf86\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\pf\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\local\\Microsoft\\Edge\\Application\\msedge.exe',
  ]);
  const withoutLocal = edgeCandidates({ 'ProgramFiles(x86)': 'C:\\pf86', ProgramFiles: 'C:\\pf' });
  assert.equal(withoutLocal.length, 2);
});

test('edgeCandidates：环境变量缺失时退回默认安装位置（不抛）', () => {
  const list = edgeCandidates({});
  assert.equal(list.length, 2);
  assert.ok(list[0].includes('Program Files (x86)'));
});

test('findEdgeExecutable：第一个存在的就返回，都不存在回 null',
  { skip: process.platform !== 'win32' && 'Edge 安装路径是 Windows 专有语义，其他平台跳过' }, () => {
  const env = { 'ProgramFiles(x86)': 'C:\\pf86', ProgramFiles: 'C:\\pf' };
  const second = 'C:\\pf\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(findEdgeExecutable({ env, exists: (p) => p === second }), second);
  assert.equal(findEdgeExecutable({ env, exists: () => false }), null);
});

test('findEdgeExecutable：探测本身抛异常也不会把调用方带崩', () => {
  const env = { 'ProgramFiles(x86)': 'C:\\pf86', ProgramFiles: 'C:\\pf' };
  assert.equal(findEdgeExecutable({ env, exists: () => { throw new Error('EACCES'); } }), null);
});

test('ssoUrlFromLoginHtml：从登录页里取出统一身份认证入口，并还原 &amp;', () => {
  const html = '<a href="https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/abc123/0?x=1&amp;y=2">登录</a>';
  const url = ssoUrlFromLoginHtml(html);
  assert.equal(url, 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/abc123/0?x=1&y=2');
});

test('ssoUrlFromLoginHtml：登录页改版（没有统一身份认证链接）时回 null', () => {
  assert.equal(ssoUrlFromLoginHtml('<html><body>没有链接</body></html>'), null);
  assert.equal(ssoUrlFromLoginHtml(''), null);
  assert.equal(ssoUrlFromLoginHtml(null), null);
});

test('cookiesToHeader：只取该主机（含子域写法）的 Cookie', () => {
  const header = cookiesToHeader([
    { name: 'JSESSIONID', value: 'a', domain: LEARN_HOST },
    { name: 'XSRF-TOKEN', value: 'b', domain: `.${LEARN_HOST}` },
    { name: 'other', value: 'c', domain: 'id.tsinghua.edu.cn' },
  ]);
  assert.equal(header, 'JSESSIONID=a; XSRF-TOKEN=b');
});

test('cookiesToHeader：不是数组也不炸，回空串', () => {
  assert.equal(cookiesToHeader(undefined), '');
  assert.equal(cookiesToHeader([]), '');
});

test('CDP：open 之后 ready 兑现，send 与响应按 id 配对', async () => {
  const client = createCdpClient('ws://127.0.0.1:9333/devtools/page/x', { WebSocketImpl: FakeSocket, timeoutMs: 200 });
  const socket = FakeSocket.last;
  socket.emit('open');
  await client.ready;

  const pending = client.send('Network.enable', { a: 1 });
  assert.deepEqual(socket.sent[0], { id: 1, method: 'Network.enable', params: { a: 1 } });
  socket.reply({ id: 1, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  client.close();
  assert.equal(socket.closed, true);
});

test('CDP：浏览器回错误时 reject 带错误信息', async () => {
  const client = createCdpClient('ws://x', { WebSocketImpl: FakeSocket, timeoutMs: 200 });
  const socket = FakeSocket.last;
  socket.emit('open');
  await client.ready;
  const pending = client.send('Page.navigate');
  socket.reply({ id: 1, error: { message: 'boom' } });
  await assert.rejects(pending, /cdp-error:boom/);
  client.close();
});

test('CDP：没等到响应就超时（不让续期永远挂住）', async () => {
  const client = createCdpClient('ws://x', { WebSocketImpl: FakeSocket, timeoutMs: 10 });
  FakeSocket.last.emit('open');
  await client.ready;
  await assert.rejects(client.send('Browser.close'), /cdp-timeout/);
  client.close();
});

test('CDP：无关的消息（无 id、未知 id、非 JSON）被忽略而不影响配对', async () => {
  const client = createCdpClient('ws://x', { WebSocketImpl: FakeSocket, timeoutMs: 200 });
  const socket = FakeSocket.last;
  socket.emit('open');
  await client.ready;
  const pending = client.send('Runtime.evaluate');
  socket.emit('message', { data: '这不是 JSON' });
  socket.reply({ method: 'Network.loadingFinished' });
  socket.reply({ id: 99, result: { ignored: true } });
  socket.reply({ id: 1, result: { ok: 1 } });
  assert.deepEqual(await pending, { ok: 1 });
  client.close();
});

test('CDP：连接失败会让 ready 失败（renew 据此回 cdp-* 而不是卡住）', async () => {
  const client = createCdpClient('ws://x', { WebSocketImpl: FakeSocket, timeoutMs: 50 });
  FakeSocket.last.emit('error', {});
  await assert.rejects(client.ready, /cdp-socket-error/);
  client.close();
});

test('CDP：运行时没有 WebSocket 实现时明确报 no-websocket', () => {
  const saved = globalThis.WebSocket;
  try {
    delete globalThis.WebSocket;
    assert.throws(() => createCdpClient('ws://x'), /no-websocket/);
  } finally {
    globalThis.WebSocket = saved;
  }
});

test('createLearnBrowser：构造不启进程、不碰磁盘，status 如实说明', () => {
  const browser = createLearnBrowser({
    profileDir: '',
    edgePath: 'C:\\pf86\\Microsoft\\Edge\\Application\\msedge.exe',
    logger: silentLogger,
  });
  const status = browser.status();
  assert.equal(status.running, false);
  assert.equal(status.pid, null);
  assert.equal(status.mode, null);
  assert.equal(status.port, LEARN_BROWSER_PORT);
  assert.equal(browser.edgeAvailable, true);
});

test('createLearnBrowser：找不到 Edge 时 edgeAvailable 为 false 且不抛', () => {
  const browser = createLearnBrowser({
    profileDir: '',
    logger: silentLogger,
    env: { 'ProgramFiles(x86)': 'C:\\没有这个目录-a', ProgramFiles: 'C:\\没有这个目录-b', LOCALAPPDATA: 'C:\\没有这个目录-c' },
  });
  assert.equal(browser.edgeAvailable, false);
  assert.equal(browser.status().edgePath, null);
});

test('createLearnBrowser：没在跑的时候 stop 是安全的空操作', async () => {
  const browser = createLearnBrowser({ profileDir: '', logger: silentLogger, edgePath: 'C:\\fake\\msedge.exe' });
  const result = await browser.stop();
  assert.equal(result.ok, true);
  assert.equal(result.stopped, false);
  assert.equal(browser.status().running, false);
});
