const sms = require('./sms');
const createBusyStore = require('./busy');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_SEND_TIME = '21:30';
const DEFAULT_DAY_START = '7am';
const DEFAULT_DAY_END = '11pm';
const MAX_TASKS = 4;
const RECENT_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function localDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysBetween(fromISO, toISO) {
  return Math.round((Date.parse(toISO) - Date.parse(fromISO)) / DAY_MS);
}

function describeGoals(goals) {
  if (!goals.length) return '(none)';
  return goals
    .map(goal => {
      const deadline = goal.deadline
        ? `deadline ${goal.deadline.slice(0, 10)} (${goal.days_remaining} day(s) away)`
        : 'no deadline';
      const subtasks = goal.subtasks.length
        ? goal.subtasks
            .map(s => `    - [${s.done ? 'done' : 'not done'}] ${s.text}`)
            .join('\n')
        : '    (no subtasks)';
      return `- ${goal.title} — ${deadline}\n${subtasks}`;
    })
    .join('\n');
}

function describeAvailability(context) {
  const { availability, window } = context;
  if (!availability.blocks.length) {
    return `${window.start}–${window.end}, treated as one continuous free block.`;
  }

  return [
    `${window.start}–${window.end}, minus time already committed:`,
    ...availability.blocks.map(block => `- ${createBusyStore.describeBlock(block)}`),
    `That leaves ${availability.freeLabel} free${
      availability.freeRanges.length ? `: ${availability.freeRanges.join(', ')}` : ''
    }. Size the day to the time that is actually left.`
  ].join('\n');
}

function describeRecent(recent) {
  if (!recent.length) return '(nothing crossed off recently)';
  return recent.map(item => `- ${item.date}: ${item.text}`).join('\n');
}

function buildPrompt(context) {
  return `You are planning ${context.planDate} for one person, from their goals.

ACTIVE GOALS
${describeGoals(context.goals)}

AVAILABLE TIME
${describeAvailability(context)}

RECENTLY COMPLETED (general context on their momentum; not linked to specific goals)
${describeRecent(context.recentlyCompleted)}

Suggest at most ${MAX_TASKS} tasks for the day — usually 2-3. Let the count follow the
nature of the work rather than a fixed number:
- A quick, bounded task ("ask Priya for a referral") takes a slice of the day, so
  several can coexist.
- A substantial, open-ended task ("work on the GovAI application") absorbs most of
  the day by itself. A day should hold at most one or two of these, never a stack
  of four.
Judge which kind each task is yourself; do not apply a formula.

Also:
- When a goal already has an incomplete subtask that fits, suggest that subtask
  verbatim instead of inventing a new task. Only invent one when no subtask fits.
- Weight goals with nearer deadlines more heavily, but rotate undated goals in
  regularly — they must not be starved by deadline-driven ones.
- Never suggest a subtask already marked done.

Reply with JSON only — no prose, no code fence — as an array of objects:
[{"task": string, "goal_title": string, "is_existing_subtask": boolean, "estimated_size": "quick" | "substantial"}]`;
}

function parseSuggestions(text) {
  // The model is asked for bare JSON, but a stray code fence or a sentence in
  // front of it shouldn't lose the whole plan.
  const withoutFence = String(text || '').replace(/```(?:json)?|```/g, '');
  const start = withoutFence.indexOf('[');
  const end = withoutFence.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('no JSON array in model response');

  const parsed = JSON.parse(withoutFence.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('model response was not an array');

  return parsed
    .filter(item => item && typeof item.task === 'string' && item.task.trim())
    .slice(0, MAX_TASKS)
    .map(item => ({
      task: item.task.trim(),
      goal_title: typeof item.goal_title === 'string' ? item.goal_title.trim() : '',
      is_existing_subtask: Boolean(item.is_existing_subtask),
      estimated_size: item.estimated_size === 'substantial' ? 'substantial' : 'quick'
    }));
}

async function requestSuggestions(context) {
  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: buildPrompt(context) }]
    })
  });

  if (!response.ok) {
    // The body carries Anthropic's own error message, which is far more useful
    // than the status alone when a model name or key is wrong.
    throw new Error(`Claude API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const payload = await response.json();
  const text = (payload.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
  return parseSuggestions(text);
}

function formatPlan(suggestions, planDate) {
  if (!suggestions.length) return `Plan for ${planDate}: nothing to suggest today.`;

  const lines = suggestions.map(item => {
    const goal = item.goal_title ? ` (${item.goal_title})` : '';
    return `• ${item.task}${goal}`;
  });
  return [`Plan for ${planDate}:`, ...lines].join('\n');
}

function planEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY && sms.canSend(process.env.PLAN_PHONE_NUMBER));
}

function parseSendTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

// The project schedules with plain timers (see lib/backup.js) rather than a
// cron dependency. Rescheduling after each run keeps the job pinned to a wall
// clock time across DST shifts, which a fixed 24h interval would drift past.
function scheduleDaily({ hours, minutes }, task) {
  let timer = null;

  const queue = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hours, minutes, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    timer = setTimeout(async () => {
      await task();
      queue();
    }, next.getTime() - now.getTime());
    timer.unref();
  };

  queue();
  return {
    stop: () => clearTimeout(timer)
  };
}

// Nightly planning is a personal feature scoped to the owner's own goals,
// busy blocks and todo history — always bound to the owner's stores.
function createPlanModule(stores) {
  const { notes, goals: goalsStore, busy } = stores;

  // Todo lists are markdown entries titled "List: Todo YYYY-MM-DD", so the date
  // scoping is read straight off the title rather than the entry's timestamp —
  // an item added just after midnight still belongs to the list it names.
  async function recentlyCompleted(planDate, days = RECENT_DAYS) {
    const oldest = localDate(new Date(Date.parse(`${planDate}T00:00:00`) - days * DAY_MS));
    const done = [];

    for (const entry of await notes.parseEntries()) {
      const match = /^List:\s*Todo\s+(\d{4}-\d{2}-\d{2})\s*$/i.exec(entry.title);
      if (!match) continue;
      const date = match[1];
      if (date < oldest || date >= planDate) continue;

      for (const line of entry.body.split('\n')) {
        const item = /^\s*[-*]\s*\[[xX]\]\s*(.+)$/.exec(line);
        if (item) done.push({ date, text: item[1].trim() });
      }
    }
    return done;
  }

  async function activeGoals(planDate) {
    const goals = await goalsStore.loadGoals();
    return goals
      .filter(goal => goal.status === 'active')
      .map(goal => ({
        title: goal.title,
        deadline: goal.deadline,
        days_remaining: goal.deadline
          ? daysBetween(`${planDate}T00:00:00`, goal.deadline)
          : null,
        subtasks: (goal.subtasks || []).map(s => ({ text: s.text, done: Boolean(s.done) }))
      }));
  }

  // Everything the model is asked to reason about, in one plain object — so a
  // test (or a future dashboard preview) can inspect the inputs without making
  // an API call.
  // planDate defaults to tomorrow, which is what the nightly job wants; the
  // dashboard passes a chosen day so a trip or a deadline week can be planned in
  // advance. Everything downstream keys off it, including which #busy blocks and
  // which recently-completed todos are read.
  async function gatherContext(now = new Date(), planDate = localDate(new Date(now.getTime() + DAY_MS))) {
    const start = process.env.PLAN_DAY_START || DEFAULT_DAY_START;
    const end = process.env.PLAN_DAY_END || DEFAULT_DAY_END;

    return {
      planDate,
      window: { start, end },
      // #busy blocks carve the plannable day down; overlapping ones are
      // collapsed here rather than at storage time.
      availability: await busy.availability(planDate, start, end),
      goals: await activeGoals(planDate),
      recentlyCompleted: await recentlyCompleted(planDate)
    };
  }

  // Generation is separated from delivery so the plan can be inspected — or a
  // send failure diagnosed — without re-running the model.
  async function generatePlan(now = new Date(), planDate) {
    const context = await gatherContext(now, planDate);

    // A day with no room left gets an honest sentence rather than suggestions
    // squeezed into time that doesn't exist — and no model call.
    if (!context.availability.freeMinutes) {
      return {
        context,
        suggestions: [],
        fullyBooked: true,
        message: `No open time on ${context.planDate} — ${context.window.start}–${context.window.end} is fully booked. Nothing to plan.`
      };
    }

    const suggestions = await requestSuggestions(context);
    return { context, suggestions, message: formatPlan(suggestions, context.planDate) };
  }

  async function runNightlyPlan(now = new Date()) {
    try {
      const plan = await generatePlan(now);
      await sms.sendMessage(process.env.PLAN_PHONE_NUMBER, plan.message);
      console.log(`Sent plan for ${plan.context.planDate} (${plan.suggestions.length} task(s))`);
      return plan;
    } catch (err) {
      console.error(`Nightly plan failed: ${err.message}`);
      return null;
    }
  }

  // Off unless both an API key and a destination number are configured, matching
  // how backups and phone sign-in stay dormant on an unconfigured deployment.
  function startPlanScheduler() {
    if (!planEnabled()) return null;

    const time = process.env.PLAN_SEND_TIME || DEFAULT_SEND_TIME;
    const parsed = parseSendTime(time);
    if (!parsed) {
      console.error(`Ignoring invalid PLAN_SEND_TIME: ${time}`);
      return null;
    }

    const handle = scheduleDaily(parsed, () => runNightlyPlan());
    console.log(`Nightly plan scheduled for ${time} local time`);
    return handle;
  }

  return {
    gatherContext,
    generatePlan,
    runNightlyPlan,
    planEnabled,
    startPlanScheduler
  };
}

module.exports = createPlanModule;
module.exports.buildPrompt = buildPrompt;
module.exports.parseSuggestions = parseSuggestions;
module.exports.formatPlan = formatPlan;
