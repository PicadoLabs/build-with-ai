const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMcpSession, isResponseMessage } = require('../lib/mcp');

async function testSessionRouting() {
  console.log('▶ Test: MCP session request routing');

  assert.strictEqual(isResponseMessage({ jsonrpc: '2.0', id: 1, result: {} }), true);
  assert.strictEqual(isResponseMessage({ jsonrpc: '2.0', id: 'a', error: { code: 1, message: 'x' } }), true);
  assert.strictEqual(isResponseMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }), false);
  assert.strictEqual(isResponseMessage({ jsonrpc: '2.0', id: null, error: {} }), false);
  assert.strictEqual(isResponseMessage({ jsonrpc: '2.0', id: 1 }), false);
  assert.strictEqual(isResponseMessage([1]), false);
  console.log('  ✔ Responses are told apart from requests and notifications.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-mcp-session-'));
  const sent = [];
  const session = createMcpSession({ cwd: dir, write: (message) => sent.push(message) });
  try {
    const ping = await session.handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping' });
    assert.deepStrictEqual(ping, { jsonrpc: '2.0', id: 7, result: {} }, 'Client requests are still answered');
    assert.strictEqual(await session.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);

    const first = session.sendRequest('test/one', { a: 1 });
    const second = session.sendRequest('test/two', {});
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[0].method, 'test/one');
    assert.deepStrictEqual(sent[0].params, { a: 1 });
    assert.notStrictEqual(sent[0].id, sent[1].id, 'Each outgoing request gets a unique id');
    assert.strictEqual(session.pendingCount(), 2);

    // Answer out of order: responses are matched by id, not position.
    assert.strictEqual(
      await session.handleMessage({ jsonrpc: '2.0', id: sent[1].id, error: { code: -1, message: 'User denied' } }),
      null
    );
    await assert.rejects(second, /client rejected test\/two: User denied/);
    await session.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: { ok: true } });
    assert.deepStrictEqual(await first, { ok: true });
    assert.strictEqual(session.pendingCount(), 0);

    assert.strictEqual(await session.handleMessage({ jsonrpc: '2.0', id: 'unknown', result: {} }), null);
    console.log('  ✔ Outgoing requests resolve or reject from matching responses, in any order.');

    await assert.rejects(session.sendRequest('test/slow', {}, { timeoutMs: 20 }), /did not answer test\/slow/);
    assert.strictEqual(session.pendingCount(), 0, 'Timed out requests are removed');
    console.log('  ✔ Unanswered requests time out.');

    const orphan = session.sendRequest('test/orphan', {});
    session.close();
    await assert.rejects(orphan, /closed before the client answered test\/orphan/);
    await assert.rejects(session.sendRequest('test/late', {}), /connection is closed/);
    assert.strictEqual(session.pendingCount(), 0);
    console.log('  ✔ Closing the session rejects outstanding and new requests.');
  } finally {
    session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let completed = false;
// A pending promise with nothing keeping the event loop alive would end the
// process early with exit code 0; treat that as a failure.
process.on('exit', (code) => {
  if (!completed && code === 0) {
    console.error('MCP tests exited before finishing.');
    process.exitCode = 1;
  }
});

async function runTests() {
  await testSessionRouting();
  completed = true;
  console.log('\nAll MCP tests passed.');
}

runTests().catch((err) => {
  console.error('MCP test failed:', err);
  process.exit(1);
});
