const express = require('express');
const rateLimit = require('express-rate-limit');
const twilio = require('twilio');
const { resolveSender } = require('../lib/accounts/resolveSender');

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

const HELP_TEXT =
  'loci commands — text anything to save it as a note. ' +
  '#todo <item> adds to today\'s list, #done <what you finished> crosses it off. ' +
  '#busy 9am-5pm work (or #busy 3pm for 2 hrs) blocks time. ' +
  '#goals <goal> tracks a goal, with "- subtask" lines under it. ' +
  '#create list <name> then items on new lines makes a list; "item #listname" adds to one. ' +
  'Text #help anytime to see this again.';

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

// Applies one message body against a resolved sender's stores. Split out from
// the route handler so the routing/error-handling above stays easy to read.
async function handleMessage({ res, body, notes, tags, goals, busy, done }) {
  const lower = body.toLowerCase();

  // 0. "#help" always short-circuits with instructions, checked first so it
  // can't be swallowed by any of the tag-detection rules below.
  if (/^#help\b/i.test(body)) {
    return res.type('text/xml').send(twiml(HELP_TEXT));
  }

  // 1. "#goals <title>" with optional "- subtask" lines. Checked before the
  // list and todo rules so a message carrying several tags becomes a goal.
  if (goals.isGoalText(body)) {
    const { goal, merged, addedSubtasks, ambiguous } = await goals.createGoal(body);
    if (!goal.title && !goal.subtasks.length) {
      return res.type('text/xml').send(twiml('Saved an untitled goal — send "#goals" followed by what you want to achieve.'));
    }
    const deadline = goal.deadline ? `, due ${goal.deadline.slice(0, 10)}` : '';

    // Say so when a message folded into an existing goal rather than starting
    // one, since the difference is invisible from the phone otherwise.
    if (merged) {
      const added = addedSubtasks ? `, ${addedSubtasks} subtask(s) added` : '';
      return res.type('text/xml').send(twiml(`Added to your existing goal "${goal.title}"${deadline}${added}.`));
    }

    const subtasks = goal.subtasks.length ? ` with ${goal.subtasks.length} subtask(s)` : '';

    // Several existing goals fit equally well, so this was saved on its own
    // rather than folded into whichever happened to be stored first.
    if (ambiguous && ambiguous.length) {
      return res.type('text/xml').send(
        twiml(
          `Goal saved: "${goal.title}"${deadline}${subtasks}. It could have joined ${ambiguous
            .map(title => `"${title}"`)
            .join(' or ')} — merge them on the dashboard if you meant one of those.`
        )
      );
    }

    return res.type('text/xml').send(twiml(`Goal saved: "${goal.title}"${deadline}${subtasks}.`));
  }

  // 2. "#busy 9am-5pm work" — or a start plus a length, "#busy 3pm for 2 hrs"
  // — marks time as unavailable on the day it names, defaulting to today.
  // Checked before the list and todo rules for the same reason #goals is: a
  // message carrying several tags resolves to the structured one rather than
  // becoming a list item.
  if (busy.isBusyText(body)) {
    const block = await busy.addBlock(body);
    if (!block) {
      return res.type('text/xml').send(
        twiml('Send "#busy" with a time range or a start and a length, like "#busy 9am-5pm work" or "#busy 3pm for 2 hrs".')
      );
    }
    const label = block.label ? ` for ${block.label}` : '';
    return res.type('text/xml').send(
      twiml(`Blocked ${busy.timeRange(block)} on ${block.date}${label}.`)
    );
  }

  // 3. New list: "#create list" followed by items on their own lines
  if (lower.startsWith('#create list')) {
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    const [, ...rest] = lines; // drop the "#create list" line
    // first remaining line may be a list name like "#create list Groceries"
    const firstLineRemainder = lines[0].replace(/#create list/i, '').trim();
    const listName = firstLineRemainder || 'Untitled List';
    const items = rest.length ? rest : [];
    // Detect tags from the list name and items only — not the "#create list"
    // command itself, or "create" would get picked up as a spurious tag.
    const detectedTags = await tags.detectTags(`${listName} ${items.join(' ')}`);
    await notes.createList(listName, items, detectedTags.length ? detectedTags : [listName]);
    return res.type('text/xml').send(twiml(`Created list "${listName}" with ${items.length} item(s).`));
  }

  // 4. "#todo <item>" goes onto the list for the day it was sent. Each line is
  // its own item, so a multi-line message becomes several tickable entries.
  if (/^#todo\b/i.test(body)) {
    const items = notes.todoItems(body.replace(/^#todo\b/i, ''));
    if (!items.length) {
      return res.type('text/xml').send(twiml('Send "#todo" followed by what you need to do.'));
    }
    await notes.addToDailyTodo(items);
    const summary = items.length === 1 ? `"${items[0]}"` : `${items.length} items`;
    return res.type('text/xml').send(twiml(`Added ${summary} to today's todo list.`));
  }

  // 5. "#done <what you finished>" ticks the closest item off today's list,
  // or records it as already finished when nothing on the list resembles it.
  if (/^#done\b/i.test(body)) {
    const text = body.replace(/^#done\b/i, '').trim();
    const result = await done.markDone(text);
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

  // 6. Add item to an existing list via trailing hashtag, e.g. "avocados #grocery"
  // Only routes here if that list already exists — otherwise falls through to
  // rule 7 below and gets saved as a regular tagged note.
  const trailingTagMatch = body.match(/#(\w+)\s*$/);
  if (trailingTagMatch) {
    const tagName = trailingTagMatch[1];
    const item = body.replace(trailingTagMatch[0], '').trim();
    if (item && (await notes.addItemToList(tagName, item))) {
      return res.type('text/xml').send(twiml(`Added "${item}" to your ${tagName} list.`));
    }
  }

  // 7. Plain note
  const detectedTags = await tags.detectTags(body);
  await notes.appendNote(body, detectedTags);
  return res.type('text/xml').send(
    twiml(detectedTags.length ? `Saved, tagged: ${detectedTags.join(', ')}.` : 'Saved.')
  );
}

// `ownerStores` (local disk) is used for OWNER_PHONE_NUMBER; every other
// sender is routed by lib/accounts/resolveSender.js to their own linked
// Google Drive, or told how to link one if they haven't yet.
function createWebhookRouter({ accountRepo, ownerStores, ownerPhone }) {
  const router = express.Router();

  router.post('/sms', webhookLimiter, validateTwilioRequest, async (req, res) => {
    const body = (req.body.Body || '').trim();

    if (!body) {
      return res.type('text/xml').send(twiml('Got an empty message — nothing saved.'));
    }

    let resolved;
    try {
      resolved = await resolveSender({
        fromNumber: req.body.From,
        accountRepo,
        ownerStores,
        ownerPhone,
        publicUrl: process.env.PUBLIC_URL
      });
    } catch (err) {
      console.error('Failed to resolve sender for webhook:', err.message);
      return res.type('text/xml').send(twiml('Something went wrong on our end — try again shortly.'));
    }

    if (resolved.kind === 'invalid') {
      return res.type('text/xml').send(twiml('Could not read your number.'));
    }
    if (resolved.kind === 'unclaimed') {
      return res.type('text/xml').send(
        twiml(
          resolved.onboarding
            ? `Connect your Google Drive to start saving notes: ${resolved.signupUrl}`
            : `You need an invite to save notes with loci. Once you have a code, sign up at ${resolved.signupUrl}`
        )
      );
    }

    const { notes, tags, goals, busy, done } = resolved.stores;

    try {
      return await handleMessage({ res, body, notes, tags, goals, busy, done });
    } catch (err) {
      console.error('Failed to handle webhook message:', err.message);
      return res.type('text/xml').send(twiml('Something went wrong saving that — try again shortly.'));
    }
  });

  return router;
}

module.exports = createWebhookRouter;
