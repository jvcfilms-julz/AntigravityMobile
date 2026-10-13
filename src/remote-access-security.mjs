/**
 * Fail-closed remote access gate for the Antigravity Mobile bridge.
 * Local setup/admin may run without pairing only over literal loopback hosts.
 * Remote clients (including other LAN/tailnet members) must provide a valid
 * x-device-token for every non-public API and the live WebSocket.
 */
const PUBLIC_API = new Set([
  'GET /api/status',
  'GET /api/auth/status',
  'POST /api/auth/login',
  'POST /api/pair',
  'GET /api/pair/status',
]);

export function isTrustedLoopback(req) {
  const ip = String(req.socket?.remoteAddress || '');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return false;

  // Do not allow an attacker-controlled DNS-rebinding hostname to inherit
  // the unrestricted local-admin trust of a 127.0.0.1 connection.
  const host = String(req.headers?.host || '');
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host);
}

export function isAllowedOrigin(req) {
  const fetchSite = req.headers?.['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const origin = req.headers?.origin;
  if (!origin) return true; // Native Android/Tailscale requests have no Origin.
  if (typeof origin !== 'string') return false;

  try {
    const url = new URL(origin);
    const host = String(req.headers?.host || '');
    return ['http:', 'https:'].includes(url.protocol) &&
      url.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function requireRemotePairing(isPaired) {
  return (req, res, next) => {
    if (!isAllowedOrigin(req)) {
      return res.status(403).json({ error: 'cross_origin_denied' });
    }

    if (!req.path.startsWith('/api/')) return next();
    if (PUBLIC_API.has(`${req.method} ${req.path}`)) return next();

    if (isTrustedLoopback(req) || isPaired(req.headers?.['x-device-token'])) {
      return next();
    }
    return res.status(403).json({ error: 'pairing_required' });
  };
}

export function verifySocketClient(isPaired) {
  return (info, done) => {
    const req = info.req;
    if (!isAllowedOrigin(req)) return done(false, 403, 'Origin denied');
    if (isTrustedLoopback(req) || isPaired(req.headers?.['x-device-token'])) {
      return done(true);
    }
    return done(false, 403, 'Device pairing required');
  };
}

export function createPairLimiter({ maxFailures = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map();
  function current(ip, now) {
    const record = failures.get(ip);
    if (!record || now - record.start >= windowMs) {
      failures.delete(ip);
      return null;
    }
    return record;
  }
  return {
    allowed(ip, now = Date.now()) {
      return (current(ip, now)?.count || 0) < maxFailures;
    },
    failure(ip, now = Date.now()) {
      const record = current(ip, now) || { start: now, count: 0 };
      record.count++;
      failures.set(ip, record);
    },
    clear(ip) {
      failures.delete(ip);
    },
  };
}
