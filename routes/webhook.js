const express = require('express');
const twilio = require('twilio');
const notes = require('../lib/notes');
const tags = require('../lib/tags');

const router = express.Router();

function twiml(message) {
  const response = new twilio.twiml.MessagingResponse();
  if (message) response.message(message);
  return response.toString();
}

// Validates that the request really came from Twilio (skips if no auth token configured,
// so local testing without Twilio still works).
function validateTwilioRequest(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken || process.env.SKIP_TWILIO_VALIDATION === 'true') return next();

  const signature = req.headers['x-twilio-signature'];
  const url = `${process.env.PUBLIC_URL}${req.originalUrl}`;
  const valid = twilio.validateRequest(authToken, signature, url, req.body);

  if (!valid) return res.status(403).send('Invalid Twilio signature');
  next();
}

router.post('/sms', validateTwilioRequest, (req, res) => {
  const body = (req.body.Body || '').trim();

  if (!body) {
    return res.type('text/xml').send(twiml('Got an empty message — nothing saved.'));
  }

  const lower = body.toLowerCase();

  // 1. New list: "#create list" followed by items on their own lines
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

  // 2. Add item to an existing list via trailing hashtag, e.g. "avocados #grocery"
  // Only routes here if that list already exists — otherwise falls through to
  // note 3 below and gets saved as a regular tagged note.
  const trailingTagMatch = body.match(/#(\w+)\s*$/);
  if (trailingTagMatch) {
    const tagName = trailingTagMatch[1];
    const item = body.replace(trailingTagMatch[0], '').trim();
    if (item && notes.addItemToList(tagName, item)) {
      return res.type('text/xml').send(twiml(`Added "${item}" to your ${tagName} list.`));
    }
  }

  // 3. Plain note
  const detectedTags = tags.detectTags(body);
  notes.appendNote(body, detectedTags);
  return res.type('text/xml').send(
    twiml(detectedTags.length ? `Saved, tagged: ${detectedTags.join(', ')}.` : 'Saved.')
  );
});

module.exports = router;
