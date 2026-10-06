'use strict';
/**
 * Synchronous HTTP for the harness.
 *
 * RESTMessageV2.execute() is synchronous on the platform, but Node's HTTP
 * APIs are asynchronous. To keep the Script Includes unchanged, the demo and
 * the integration test make each request in a short-lived child process and
 * wait for it with spawnSync. This is slow and only for local demos; the
 * server under test must run in a separate process.
 */
const { spawnSync } = require('node:child_process');

const CHILD = `
const req = JSON.parse(process.argv[1]);
(async () => {
  try {
    const res = await fetch(req.endpoint, {
      method: req.method.toUpperCase(),
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(req.timeout || 10000),
    });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    process.stdout.write(JSON.stringify({ status: res.status, body: await res.text(), headers }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ status: 0, error: String(e && e.message ? e.message : e) }));
  }
})();
`;

function syncRequest(req) {
  const out = spawnSync(process.execPath, ['-e', CHILD, JSON.stringify(req)], {
    encoding: 'utf8',
    timeout: (req.timeout || 10000) + 5000,
  });
  if (out.error) return { status: 0, error: out.error.message };
  try {
    return JSON.parse(out.stdout);
  } catch {
    return { status: 0, error: `transport failed: ${out.stderr || out.stdout}` };
  }
}

/** Token issuer that performs a client-credentials grant against the mock server. */
function oauthIssuer(tokenUrl, clientId, clientSecret) {
  return () => {
    const res = syncRequest({
      method: 'post',
      endpoint: tokenUrl,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    });
    if (res.status !== 200) return null;
    const body = JSON.parse(res.body);
    return { accessToken: body.access_token, expiresIn: body.expires_in };
  };
}

module.exports = { syncRequest, oauthIssuer };
