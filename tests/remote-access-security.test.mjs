import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPairLimiter, isAllowedOrigin, isTrustedLoopback,
  requireRemotePairing, verifySocketClient
} from '../src/remote-access-security.mjs';

const paired = token => token === 'known-long-lived-token';
function request({ ip = '100.101.102.103', method = 'POST', path = '/api/cdp/inject',
  host = '100.101.102.104:5000', token, origin, fetchSite } = {}) {
  const headers = { host };
  if (token !== undefined) headers['x-device-token'] = token;
  if (origin !== undefined) headers.origin = origin;
  if (fetchSite !== undefined) headers['sec-fetch-site'] = fetchSite;
  return { method, path, socket: { remoteAddress: ip }, headers };
}
function checkHttp(req) {
  const outcome = { next: false, status: null, body: null };
  const res = {
    status(code) { outcome.status = code; return this; },
    json(body) { outcome.body = body; return this; },
  };
  requireRemotePairing(paired)(req, res, () => { outcome.next = true; });
  return outcome;
}
function checkSocket(req) {
  let result;
  verifySocketClient(paired)({ req }, (...args) => { result = args; });
  return result;
}

test('nonpaired tailnet device cannot inject IDE commands, read files or reach Git', () => {
  for (const path of ['/api/cdp/inject', '/api/git/commit', '/api/files']) {
    const out = checkHttp(request({ path }));
    assert.equal(out.status, 403);
    assert.equal(out.body.error, 'pairing_required');
  }
});
test('paired tailnet device can use protected APIs', () => {
  assert.equal(checkHttp(request({ token: 'known-long-lived-token' })).next, true);
});
test('public health and pairing endpoints remain available before pairing', () => {
  for (const [method, path] of [
    ['GET', '/api/status'], ['POST', '/api/pair'],
    ['GET', '/api/pair/status'], ['GET', '/api/auth/status']
  ]) {
    assert.equal(checkHttp(request({ method, path })).next, true);
  }
});
test('only a real loopback socket with literal loopback Host is locally trusted', () => {
  assert.equal(isTrustedLoopback(request({ ip: '127.0.0.1', host: 'localhost:5000' })), true);
  assert.equal(isTrustedLoopback(request({ ip: '::1', host: '[::1]:5000' })), true);
  assert.equal(isTrustedLoopback(request({ ip: '127.0.0.1', host: 'rebinding.example:5000' })), false);
  assert.equal(isTrustedLoopback(request({ ip: '192.168.1.5', host: 'localhost:5000' })), false);
  assert.equal(checkHttp(request({ ip: '127.0.0.1', host: 'localhost:5000' })).next, true);
});
test('cross-origin requests are blocked, even from local browsers and paired clients', () => {
  assert.equal(isAllowedOrigin(request({ origin: 'http://evil.example' })), false);
  assert.equal(checkHttp(request({ ip: '127.0.0.1', host: 'localhost:5000', origin: 'https://evil.example' })).status, 403);
  assert.equal(checkHttp(request({ token: 'known-long-lived-token', fetchSite: 'cross-site' })).status, 403);
});
test('WebSocket handshake rejects unpaired and cross-origin sessions', () => {
  assert.deepEqual(checkSocket(request()), [false, 403, 'Device pairing required']);
  assert.deepEqual(checkSocket(request({ token: 'known-long-lived-token' })), [true]);
  assert.deepEqual(checkSocket(request({ ip: '127.0.0.1', host: 'localhost:5000' })), [true]);
  assert.deepEqual(checkSocket(request({ token: 'known-long-lived-token', origin: 'https://evil.example' })), [false, 403, 'Origin denied']);
});
test('pairing attempts lock after five failures and reset after the window', () => {
  const limiter = createPairLimiter();
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.allowed('100.101.102.103', 0), true);
    limiter.failure('100.101.102.103', 0);
  }
  assert.equal(limiter.allowed('100.101.102.103', 0), false);
  assert.equal(limiter.allowed('100.101.102.103', 15 * 60 * 1000), true);
  limiter.failure('100.101.102.103', 15 * 60 * 1000);
  limiter.clear('100.101.102.103');
  assert.equal(limiter.allowed('100.101.102.103', 15 * 60 * 1000), true);
});
