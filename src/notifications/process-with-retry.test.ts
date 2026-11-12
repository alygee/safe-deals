import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DLQ_TOPIC, Sender } from '../kafka';
import { IncomingMessage, processWithRetry } from './process-with-retry';

const message: IncomingMessage = { key: Buffer.from('deal-1'), value: Buffer.from('{}'), headers: { 'event-id': '7' } };

function fakeDlq() {
  const sent: any[] = [];
  const dlq: Sender = { send: async (r) => (sent.push(r), []) };
  return { dlq, sent };
}

test('временная ошибка: повтор успешен, в DLQ ничего не уходит', async () => {
  const { dlq, sent } = fakeDlq();
  let calls = 0;
  const handle = async () => {
    if (++calls < 3) throw new Error('db timeout');
  };

  assert.equal(await processWithRetry(message, handle, dlq, 3, 1), 'ok');
  assert.equal(calls, 3);
  assert.equal(sent.length, 0);
});

test('постоянная ошибка: после всех попыток сообщение уходит в DLQ с причиной', async () => {
  const { dlq, sent } = fakeDlq();
  let calls = 0;
  const handle = async () => {
    calls++;
    throw new Error('broken payload');
  };

  assert.equal(await processWithRetry(message, handle, dlq, 3, 1), 'dlq');
  assert.equal(calls, 3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].topic, DLQ_TOPIC);
  const [dead] = sent[0].messages;
  assert.equal(dead.key, message.key);
  assert.equal(dead.headers['event-id'], '7');
  assert.equal(dead.headers.error, 'broken payload');
  assert.equal(dead.headers.attempts, '3');
});
