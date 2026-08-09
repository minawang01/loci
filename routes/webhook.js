const express = require('express');
const rateLimit = require('express-rate-limit');
const twilio = require('twilio');
const notes = require('../lib/notes');
const tags = require('../lib/tags');
const goals = require('../lib/goals');
const done = require('../lib/done');

const router = express.Router();

// A personal number sends a handful of messages a minute at most; anything
// beyond that on a public URL is abuse or a retry storm.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.WEBHOOK_RATE_LIMIT || 30),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: 'Too many requests'
});

function twiml(message) {
  const response = new twilio.twiml.MessagingResponse();
  if (message) response.message(message);
  return response.toString();
}

// Validates that the request really came from Twilio. Validation is mandatory
// when NODE_ENV=production; outside production it can be skipped so local
// testing works without Twilio credentials.
function validateTwilioRequest(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const publicUrl = process.env.PUBLIC_URL;

  if (process.env.NODE_ENV !== 'production') {
    if (!authToken || !publicUrl || process.env.SKIP_TWILIO_VALIDATION === 'true') return next();
  } else if (!authToken || !publicUrl) {
    console.error('TWILIO_AUTH_TOKEN and PUBLIC_URL are required to validate webhook requests');
    return res.status(500).send('Webhook validation is not configured');
  }

  const signature = req.headers['x-twilio-signature'];
  // Twilio signs the exact URL it was configured with, which is the public
  // origin plus the original path and query — not the internal request host.
  const url = new URL(req.originalUrl, publicUrl).toString();
  const valid =
    typeof signature === 'string' &&
    twilio.validateRequest(authToken, signature, url, req.body);

  if (!valid) return res.status(403).send('Invalid Twilio signature');
  next();
}

router.post('/sms', webhookLimiter, validateTwilioRequest, (req, res) => {
  const body = (req.body.Body || '').trim();

  if (!body) {
    return res.type('text/xml').send(twiml('Got an empty message — nothing saved.'));
  }

  const lower = body.toLowerCase();

  // 1. "#goals <title>" with optional "- subtask" lines. Checked before the
  // list and todo rules so a message carrying several tags becomes a goal.
  if (goals.isGoalText(body)) {
    const goal = goals.createGoal(body);
    if (!goal.title && !goal.subtasks.length) {
      return res.type('text/xml').send(twiml('Saved an untitled goal — send "#goals" followed by what you want to achieve.'));
    }
    const deadline = goal.deadline ? `, due ${goal.deadline.slice(0, 10)}` : '';
    const subtasks = goal.subtasks.length ? ` with ${goal.subtasks.length} subtask(s)` : '';
    return res.type('text/xml').send(twiml(`Goal saved: "${goal.title}"${deadline}${subtasks}.`));
  }

  // 2. New list: "#create list" followed by items on their own lines
  if (lower.startsWith('#create list')) {
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    const [, ...rest] = lines; // drop the "#create list" line
    // first remaining line may be a list name like "#create list Groceries"
    const firstLineRemainder = lines[0].replace(/#create list/i, '').trim();
    const listName = firstLineRemainder || 'Untitled List';
    const items = rest.length ? rest : [];
    // Detect tags from the list name and items only — not the "#create list"
    // command itself, or "create" would get picked up as a spurious tag.
    const detectedTags = tags.detectTags(`${listName} ${items.join(' ')}`);
    notes.createList(listName, items, detectedTags.length ? detectedTags : [listName]);
    return res.type('text/xml').send(twiml(`Created list "${listName}" with ${items.length} item(s).`));
  }

  // 3. "#todo <item>" goes onto the list for the day it was sent
  if (/^#todo\b/i.test(body)) {
    const item = body.replace(/^#todo\b/i, '').trim();
    if (!item) {
      return res.type('text/xml').send(twiml('Send "#todo" followed by what you need to do.'));
    }
    notes.addToDailyTodo(item);
    return res.type('text/xml').send(twiml(`Added "${item}" to today's todo list.`));
  }

  // 4. "#done <what you finished>" ticks the closest item off today's list,
  // or records it as already finished when nothing on the list resembles it.
  if (/^#done\b/i.test(body)) {
    const text = body.replace(/^#done\b/i, '').trim();
    const result = done.markDone(text);
    if (!result) {
      return res.type('text/xml').send(twiml('Send "#done" followed by what you finished.'));
    }
    return res.type('text/xml').send(
      twiml(
        result.matched
          ? `Crossed off "${result.text}".`
          : `Nothing on today's list matched, so "${result.text}" was added as done.`
      )
    );
  }

  // 5. Add item to an existing list via trailing hashtag, e.g. "avocados #grocery"
  // Only routes here if that list already exists — otherwise falls through to
  // rule 5 below and gets saved as a regular tagged note.
  const trailingTagMatch = body.match(/#(\w+)\s*$/);
  if (trailingTagMatch) {
    const tagName = trailingTagMatch[1];
    const item = body.replace(trailingTagMatch[0], '').trim();
    if (item && notes.addItemToList(tagName, item)) {
      return res.type('text/xml').send(twiml(`Added "${item}" to your ${tagName} list.`));
    }
  }

  // 6. Plain note
  const detectedTags = tags.detectTags(body);
  notes.appendNote(body, detectedTags);
  return res.type('text/xml').send(
    twiml(detectedTags.length ? `Saved, tagged: ${detectedTags.join(', ')}.` : 'Saved.')
  );
});

module.exports = router;
