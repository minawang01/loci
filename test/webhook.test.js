const assert = require('assert');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const createWebhookRouter = require('../routes/webhook');

describe('Webhook #help', function() {
  const ownerPhone = '+14024170066';

  // Any store call would mean #help fell through to a save rule instead of
  // short-circuiting, so every method throws.
  function stubStores() {
    const fail = name => () => { throw new Error(`${name} should not be called for #help`); };
    return {
      notes: { appendNote: fail('notes.appendNote'), addToDailyTodo: fail('notes.addToDailyTodo'), addItemToList: fail('notes.addItemToList'), createList: fail('notes.createList') },
      tags: { detectTags: fail('tags.detectTags') },
      goals: { isGoalText: () => false, createGoal: fail('goals.createGoal') },
      busy: { isBusyText: () => false, addBlock: fail('busy.addBlock') },
      done: { markDone: fail('done.markDone') }
    };
  }

  it('replies with instructions and never touches a store', async function() {
    const app = express();
    app.use(bodyParser.urlencoded({ extended: false }));
    const accountRepo = { findByPhoneHash: () => { throw new Error('should not be called'); } };
    app.use('/webhook', createWebhookRouter({ accountRepo, ownerStores: stubStores(), ownerPhone }));

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    const formBody = new URLSearchParams({ From: ownerPhone, Body: '#help' }).toString();
    const reply = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/webhook/sms',
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(formBody) }
        },
        res => {
          let raw = '';
          res.on('data', c => (raw += c));
          res.on('end', () => resolve({ status: res.statusCode, text: raw }));
        }
      );
      req.on('error', reject);
      req.write(formBody);
      req.end();
    });

    server.close();

    assert.strictEqual(reply.status, 200);
    assert.ok(reply.text.includes('loci commands'));
    assert.ok(reply.text.includes('#todo'));
  });
});
