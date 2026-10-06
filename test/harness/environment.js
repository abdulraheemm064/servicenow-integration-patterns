'use strict';
/**
 * Loads the Script Includes into an isolated vm context that exposes the
 * mocked platform globals, much like the instance's script engine: each
 * file defines a global (var CBRestClient = Class.create(); ...), and they
 * reference each other by name at runtime.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mocks = require('./glide-mocks');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const SCRIPT_INCLUDE_DIR = path.join(SRC, 'script-includes');

const DEFAULT_CONNECTIONS = {
  'x_cbk_int.core_banking': {
    connection_url: 'https://core-banking.test.contoso-bank.example',
    oauth_profile: 'Contoso Core Banking OAuth',
    timeout_ms: '5000',
  },
};

/**
 * @param {object}   options
 * @param {Function} options.transport    fake HTTP transport for RESTMessageV2
 * @param {Function} options.tokenIssuer  fake OAuth token issuer
 * @param {object}   options.connections  alias -> connection attributes
 * @param {object}   options.properties   system properties
 */
function createEnv(options = {}) {
  const clock = mocks.createClock();
  const db = new mocks.MemoryDb();
  const httpCalls = [];
  let tokenCounter = 0;
  const tokenIssuer =
    options.tokenIssuer ||
    (() => {
      tokenCounter += 1;
      return { accessToken: `test-access-token-${tokenCounter}`, expiresIn: 300 };
    });
  const transport =
    options.transport ||
    (() => {
      throw new Error('no transport configured for this test');
    });
  const gs = mocks.createGs({ properties: options.properties || {}, clock });

  const context = vm.createContext({
    Class: mocks.Class,
    gs,
    GlideRecord: mocks.createGlideRecordClass(db),
    GlideDateTime: mocks.createGlideDateTimeClass(clock),
    GlideDigest: mocks.GlideDigest,
    sn_ws: mocks.createSnWs(transport, httpCalls),
    sn_auth: mocks.createSnAuth(tokenIssuer),
    sn_cc: mocks.createSnCc(options.connections || DEFAULT_CONNECTIONS),
  });

  for (const file of fs.readdirSync(SCRIPT_INCLUDE_DIR).sort()) {
    if (!file.endsWith('.js')) continue;
    const code = fs.readFileSync(path.join(SCRIPT_INCLUDE_DIR, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }

  /** Run a Scripted REST resource script with mocked request/response. */
  function runResource(relativeFile, request) {
    const response = mocks.createRestResponse();
    context.request = request;
    context.response = response;
    const code = fs.readFileSync(path.join(SRC, relativeFile), 'utf8');
    vm.runInContext(code, context, { filename: relativeFile });
    delete context.request;
    delete context.response;
    return response;
  }

  return { ctx: context, db, gs, clock, httpCalls, runResource };
}

/** Build an HTTP transport from a queue of canned responses. */
function scriptedTransport(responses) {
  const queue = responses.slice();
  return () => {
    if (!queue.length) throw new Error('scriptedTransport: no more responses queued');
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
}

function json(status, body, headers = {}) {
  return { status, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } };
}

module.exports = { createEnv, scriptedTransport, json, DEFAULT_CONNECTIONS, mocks };
