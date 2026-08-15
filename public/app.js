const board = document.getElementById('board');
const emptyState = document.getElementById('emptyState');
const goalBoard = document.getElementById('goalBoard');
const goalEmpty = document.getElementById('goalEmpty');
const tabsEl = document.getElementById('tabs');
const searchEl = document.querySelector('.search');
const layout = document.getElementById('layout');
const todayDateEl = document.getElementById('todayDate');
const todayItemsEl = document.getElementById('todayItems');
const todayEmptyEl = document.getElementById('todayEmpty');
const busyBoard = document.getElementById('busyBoard');
const busyEmpty = document.getElementById('busyEmpty');
const detail = document.getElementById('detail');
const detailMeta = document.getElementById('detailMeta');
const detailTitle = document.getElementById('detailTitle');
const detailItems = document.getElementById('detailItems');
const detailTags = document.getElementById('detailTags');
const backButton = document.getElementById('back');
const detailDelete = document.getElementById('detailDelete');
const logoutButton = document.getElementById('logout');
const infoButton = document.getElementById('info');
const infoOverlay = document.getElementById('infoOverlay');
const infoClose = document.getElementById('infoClose');
const menuTrigger = document.getElementById('menuTrigger');
const menuPanel = document.getElementById('menuPanel');
const topbarEl = document.querySelector('.topbar');
const searchInput = document.getElementById('search');
const tagFilterEl = document.getElementById('tagFilter');
const planEl = document.getElementById('plan');
const planButton = document.getElementById('planButton');
const planDateInput = document.getElementById('planDate');
const planResult = document.getElementById('planResult');
const composer = document.getElementById('composer');
const composerInput = document.getElementById('composerInput');
const composerNotice = document.getElementById('composerNotice');
const sessionRoleEl = document.getElementById('sessionRole');

let noticeTimer = null;

function notify(message) {
  composerNotice.textContent = message;
  composerNotice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    composerNotice.hidden = true;
  }, 12000);
}

const PREVIEW_ITEMS = 4;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK = 7;

let activeTag = null;
let activeView = 'notes';
let entries = [];
let goals = [];
let busyDays = [];
let editingGoal = null;
let selectedIndex = null;
let todayListTitle = null;
let todayEntry = null;

// The session cookie can expire while a tab sits open; bounce to the login
// page instead of quietly rendering an empty dashboard.
async function api(path, options) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    window.location.replace('/login');
    throw new Error('unauthenticated');
  }
  // A session that has verified its number but not yet connected a Drive has
  // nothing to read: it belongs on the onboarding page, not here.
  if (res.status === 403) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.onboarding) {
      window.location.replace('/onboarding');
      throw new Error('onboarding');
    }
  }
  return res;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// "2026-08-01 02:12" -> { date: "Aug 1", time: "2:12 AM" }
function formatStamp(dateTime) {
  const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/.exec(dateTime || '');
  if (!match) return { date: dateTime || '', time: '' };
  const [, , month, day, hour, minute] = match;
  const h = Number(hour);
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return {
    date: `${MONTHS[Number(month) - 1]} ${Number(day)}`,
    time: `${hour12}:${minute} ${suffix}`
  };
}

// A list entry keeps its name in the title and its checklist in the body;
// a plain note has no name, so its first line stands in as the title.
function shapeEntry(entry) {
  const stamp = formatStamp(entry.dateTime);
  const lines = entry.body.split('\n').filter(line => line.trim());
  const isList = /^list:/i.test(entry.title);

  if (isList) {
    // Every line of a list is an item, whether or not it carries a checkbox —
    // older multi-line "#todo" messages landed as bare lines. checkIndex counts
    // them the same way the server does, so both agree on which one was ticked.
    let checkIndex = -1;
    return {
      ...stamp,
      id: entry.id,
      dateTime: entry.dateTime,
      title: entry.title.replace(/^list:\s*/i, ''),
      tags: entry.tags,
      items: lines.map(line => {
        const checkbox = /^[-*]\s*\[([ xX])\]\s*(.*)$/.exec(line);
        if (!checkbox) {
          return { text: line.replace(/^[-*]\s*/, ''), done: false, marker: '–', checkIndex: ++checkIndex };
        }
        const done = checkbox[1].toLowerCase() === 'x';
        return { text: checkbox[2], done, marker: done ? '✓' : '–', checkIndex: ++checkIndex };
      })
    };
  }

  return {
    ...stamp,
    id: entry.id,
    dateTime: entry.dateTime,
    title: lines[0] || '',
    tags: entry.tags,
    items: lines.slice(1).map(text => ({ text, done: false, marker: '', checkIndex: null }))
  };
}

function itemHtml(item) {
  const body = `
      ${item.marker ? `<span class="marker">${item.marker}</span>` : ''}
      <span class="text">${escapeHtml(item.text)}</span>`;

  if (item.checkIndex === null || item.checkIndex === undefined) {
    return `<div class="item${item.done ? ' done' : ''}">${body}</div>`;
  }

  return `
    <button type="button" class="item checkable${item.done ? ' done' : ''}"
            data-item="${item.checkIndex}" aria-pressed="${item.done}">${body}
    </button>`;
}

// Ticking an item rewrites notes.md, so the feed is reloaded rather than
// patched in place — same reasoning as deleteNote.
async function toggleItem(entry, checkIndex) {
  const res = await api(
    `/api/notes/${entry.id}/items/${checkIndex}?dateTime=${encodeURIComponent(entry.dateTime)}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }
  );
  if (!res.ok) window.alert('Could not update that item — it may have already changed. Reloading.');
  await loadToday();
  await loadNotes();
  if (selectedIndex !== null) showDetail(selectedIndex);
}

function renderFeed() {
  board.innerHTML = '';
  emptyState.hidden = entries.length > 0;

  entries.forEach((raw, index) => {
    const entry = shapeEntry(raw);
    const hidden = Math.max(0, entry.items.length - PREVIEW_ITEMS);
    // A div rather than a button so the delete control can nest inside it.
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.dataset.index = index;
    card.innerHTML = `
      <button type="button" class="delete" data-delete aria-label="Delete this note">×</button>
      <div class="card-meta">
        <span class="card-date">${escapeHtml(entry.date)} · ${escapeHtml(entry.time)}</span>
        ${entry.tags[0] ? `<span class="card-tag">${escapeHtml(entry.tags[0])}</span>` : ''}
      </div>
      ${entry.title ? `<div class="card-title">${escapeHtml(entry.title)}</div>` : ''}
      <div class="card-items">
        ${entry.items.slice(0, PREVIEW_ITEMS).map(itemHtml).join('')}
      </div>
      ${hidden ? `<div class="more">+${hidden} more</div>` : ''}
    `;
    board.appendChild(card);
  });
}

// "2026-12-01T12:00:00.000Z" -> "Dec 1", plus a rough sense of urgency.
function formatDeadline(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const label = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  const days = Math.round((date - new Date()) / 86400000);
  if (days < 0) return `${label} · overdue`;
  if (days === 0) return `${label} · today`;
  if (days === 1) return `${label} · tomorrow`;
  return `${label} · in ${days} days`;
}

// A date input speaks YYYY-MM-DD in local time; a deadline is stored as an
// instant. Both directions go through midday so a timezone offset can't shift
// the day either way.
function localDay(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function deadlineInputValue(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : localDay(date);
}

function deadlineFromInput(value) {
  return value ? new Date(`${value}T12:00:00`).toISOString() : null;
}

function goalSubtaskHtml(goal) {
  return goal.subtasks
    .map(
      subtask => `
    <button type="button" class="item goal-subtask${subtask.done ? ' done' : ''}"
            data-subtask="${escapeHtml(subtask.id)}"
            aria-pressed="${subtask.done}">
      <span class="marker">${subtask.done ? '✓' : '–'}</span>
      <span class="text">${escapeHtml(subtask.text)}</span>
    </button>`
    )
    .join('');
}

function renderGoals() {
  goalBoard.innerHTML = '';
  goalEmpty.hidden = goals.length > 0;

  // Active goals first; within each group, newest first.
  const ordered = [...goals].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
    return String(b.created_at).localeCompare(String(a.created_at));
  });

  ordered.forEach(goal => {
    const created = new Date(goal.created_at);
    const createdLabel = Number.isNaN(created.getTime())
      ? ''
      : `${MONTHS[created.getMonth()]} ${created.getDate()}`;
    const card = document.createElement('div');
    card.className = `card goal${goal.status === 'done' ? ' goal-done' : ''}`;
    card.dataset.goal = goal.id;
    card.innerHTML = `
      <div class="card-meta">
        <span class="card-date">${escapeHtml(createdLabel)}</span>
        ${goal.deadline ? `<span class="card-tag">${escapeHtml(formatDeadline(goal.deadline))}</span>` : ''}
      </div>
      ${
        editingGoal === goal.id
          ? `<div class="goal-edit">
               <input type="text" class="goal-edit-title" data-edit-title value="${escapeHtml(goal.title || '')}" placeholder="What do you want to achieve?" />
               <input type="date" class="goal-edit-date" data-edit-deadline value="${goal.deadline ? deadlineInputValue(goal.deadline) : ''}" />
             </div>`
          : `<div class="card-title">${escapeHtml(goal.title || 'Untitled goal')}</div>`
      }
      <div class="card-items">${goalSubtaskHtml(goal)}</div>
      <div class="goal-actions">
        ${
          editingGoal === goal.id
            ? `<button type="button" class="goal-status" data-save>Save</button>
               <button type="button" class="goal-link" data-cancel>Cancel</button>`
            : `<button type="button" class="goal-status" data-status>
                 ${goal.status === 'done' ? 'Mark active' : 'Mark complete'}
               </button>
               <button type="button" class="goal-link" data-edit>Edit</button>
               <button type="button" class="goal-link danger" data-delete-goal>Delete</button>`
        }
      </div>
    `;
    goalBoard.appendChild(card);
  });
}

async function loadGoals() {
  const res = await api('/api/goals');
  goals = await res.json();
  renderGoals();
}

// "2026-08-11" -> "Tuesday · Aug 11", with today and tomorrow named instead,
// which is how you actually think about the week ahead.
function dayHeading(date, index) {
  const parsed = new Date(`${date}T12:00:00`);
  const label = `${MONTHS[parsed.getMonth()]} ${parsed.getDate()}`;
  if (index === 0) return { name: 'Today', label };
  if (index === 1) return { name: 'Tomorrow', label };
  return { name: DAYS[parsed.getDay()], label };
}

function renderBusy() {
  const total = busyDays.reduce((count, day) => count + day.blocks.length, 0);
  busyEmpty.hidden = activeView !== 'busy' || total > 0;
  busyBoard.innerHTML = busyDays
    .map((day, index) => {
      const { name, label } = dayHeading(day.date, index);
      return `<div class="week-day${day.blocks.length ? '' : ' free'}">
        <div class="week-head">
          <span class="week-name">${escapeHtml(name)}</span>
          <span class="week-date">${escapeHtml(label)}</span>
        </div>
        ${
          day.blocks.length
            ? day.blocks
                .map(
                  block => `<div class="busy-block">
                    <span class="busy-time">${escapeHtml(block.time)}</span>
                    ${block.label ? `<span class="busy-name">${escapeHtml(block.label)}</span>` : ''}
                    <button type="button" class="busy-delete" data-date="${escapeHtml(day.date)}" data-block="${escapeHtml(block.id)}" aria-label="Delete this block">×</button>
                  </div>`
                )
                .join('')
            : '<div class="week-free">Open</div>'
        }
      </div>`;
    })
    .join('');
}

async function loadBusy() {
  const res = await api(`/api/busy?days=${WEEK}`);
  const { days } = await res.json();
  busyDays = days;
  renderBusy();
}

function showView(view) {
  activeView = view;
  const notesView = view === 'notes';
  const goalsView = view === 'goals';
  const busyView = view === 'busy';
  searchEl.hidden = !notesView;
  tagFilterEl.hidden = !notesView;
  board.hidden = !notesView;
  emptyState.hidden = !notesView || entries.length > 0;
  goalBoard.hidden = !goalsView;
  goalEmpty.hidden = !goalsView || goals.length > 0;
  // Planning is a thing you do against your goals, so it lives with them.
  planEl.hidden = !goalsView;
  busyBoard.hidden = !busyView;
  busyEmpty.hidden = !busyView || busyDays.some(day => day.blocks.length);
  tabsEl.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });
}

function showDetail(index) {
  const entry = shapeEntry(entries[index]);
  selectedIndex = index;
  detailMeta.textContent = `${entry.date} · ${entry.time}`;
  detailTitle.textContent = entry.title;
  detailItems.innerHTML = entry.items.map(itemHtml).join('');
  detailTags.innerHTML = entry.tags
    .map(tag => `<span>${escapeHtml(tag)}</span>`)
    .join('');
  layout.hidden = true;
  detail.hidden = false;
  window.scrollTo(0, 0);
}

function showFeed() {
  selectedIndex = null;
  detail.hidden = true;
  layout.hidden = false;
}

async function loadNotes() {
  const params = new URLSearchParams();
  if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
  if (activeTag) params.set('tag', activeTag);
  const res = await api(`/api/notes?${params.toString()}`);
  const all = await res.json();
  // Today's todo list has its own column, so keep it out of the feed — but
  // leave it in search and tag results, where hiding a match would be wrong.
  const filtering = params.has('q') || params.has('tag');
  entries = filtering ? all : all.filter(entry => entry.title !== todayListTitle);
  renderFeed();
  showView(activeView);
}

async function loadToday() {
  const res = await api('/api/todos/today');
  const { name, entry } = await res.json();
  todayEntry = entry;
  todayListTitle = `List: ${name}`;
  todayDateEl.textContent = formatStamp(`${name.replace(/^Todo\s*/, '')} 00:00`).date;

  const items = entry ? shapeEntry(entry).items : [];
  todayItemsEl.innerHTML = items.map(itemHtml).join('');
  todayEmptyEl.hidden = items.length > 0;
}

// Which storage this session reads: the owner's own notes, or a claimed
// account's own Google Drive. Worth saying out loud, since the two views are
// otherwise identical.
async function loadWhoami() {
  const res = await api('/api/whoami');
  const { role } = await res.json();
  sessionRoleEl.textContent = role === 'owner' ? 'Signed in as owner' : 'Signed in as your account';
  sessionRoleEl.hidden = false;
}

async function loadTags() {
  const res = await api('/api/tags');
  const tags = await res.json();
  tagFilterEl.innerHTML = tags
    .map(
      tag =>
        `<button type="button" class="tag-chip${tag.name === activeTag ? ' active' : ''}" data-tag="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}</button>`
    )
    .join('');
}

function planTaskHtml(task) {
  const goal = task.goal_title
    ? `<span class="plan-goal">${escapeHtml(task.goal_title)}</span>`
    : '';
  return `<div class="plan-task${task.estimated_size === 'substantial' ? ' big' : ''}">
    <span class="text">${escapeHtml(task.task)}</span>${goal}
  </div>`;
}

// Generation takes a few seconds, so the button carries its own progress and
// error state rather than leaving the column looking inert.
async function generatePlan() {
  planButton.disabled = true;
  planButton.textContent = 'Thinking…';
  planResult.hidden = false;
  planResult.innerHTML = '';

  try {
    const res = await api('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(planDateInput.value ? { date: planDateInput.value } : {})
    });
    const data = await res.json();

    if (!res.ok) {
      planResult.innerHTML = `<p class="plan-error">${escapeHtml(data.error || 'Could not generate a plan.')}</p>`;
      return;
    }
    if (data.suggestions.length) {
      planResult.innerHTML = data.suggestions.map(planTaskHtml).join('');
    } else {
      // A day with no free time left comes back with an explanation rather
      // than tasks, and saying "add a goal first" would be a lie.
      planResult.innerHTML = `<p class="plan-error">${escapeHtml(
        data.fullyBooked ? data.message : 'Nothing to suggest — add a goal first.'
      )}</p>`;
    }
  } catch (err) {
    planResult.innerHTML = '<p class="plan-error">Could not reach the server.</p>';
  } finally {
    planButton.disabled = false;
    planButton.textContent = 'Make a plan';
  }
}

// Deleting rewrites notes.md, which renumbers every entry after it, so the
// feed is always reloaded rather than patched in place.
async function deleteNote(index) {
  const entry = entries[index];
  const label = entry.title === 'Note' ? 'this note' : `"${entry.title}"`;
  if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;

  const res = await api(
    `/api/notes/${entry.id}?dateTime=${encodeURIComponent(entry.dateTime)}`,
    { method: 'DELETE' }
  );
  if (!res.ok) {
    window.alert('Could not delete that note — it may have already changed. Reloading.');
  }
  showFeed();
  await loadToday();
  await loadNotes();
}

board.addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  const index = Number(card.dataset.index);
  if (e.target.closest('[data-delete]')) return deleteNote(index);
  const item = e.target.closest('[data-item]');
  if (item) return toggleItem(shapeEntry(entries[index]), Number(item.dataset.item));
  showDetail(index);
});

todayItemsEl.addEventListener('click', e => {
  const item = e.target.closest('[data-item]');
  if (item && todayEntry) toggleItem(shapeEntry(todayEntry), Number(item.dataset.item));
});

detailItems.addEventListener('click', e => {
  const item = e.target.closest('[data-item]');
  if (item && selectedIndex !== null) {
    toggleItem(shapeEntry(entries[selectedIndex]), Number(item.dataset.item));
  }
});

board.addEventListener('keydown', e => {
  const card = e.target.closest('.card');
  if (!card || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  showDetail(Number(card.dataset.index));
});

tabsEl.addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  showFeed();
  showView(tab.dataset.view);
});

goalBoard.addEventListener('click', async e => {
  const card = e.target.closest('.goal');
  if (!card) return;
  const id = card.dataset.goal;
  const subtask = e.target.closest('[data-subtask]');

  if (subtask) {
    await api(`/api/goals/${encodeURIComponent(id)}/subtasks/${encodeURIComponent(subtask.dataset.subtask)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    return loadGoals();
  }

  if (e.target.closest('[data-status]')) {
    await api(`/api/goals/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    return loadGoals();
  }

  if (e.target.closest('[data-edit]')) {
    editingGoal = id;
    return renderGoals();
  }

  if (e.target.closest('[data-cancel]')) {
    editingGoal = null;
    return renderGoals();
  }

  if (e.target.closest('[data-save]')) {
    const title = card.querySelector('[data-edit-title]').value.trim();
    if (!title) return window.alert('A goal needs a title.');
    const res = await api(`/api/goals/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        deadline: deadlineFromInput(card.querySelector('[data-edit-deadline]').value)
      })
    });
    if (!res.ok) window.alert('Could not save that goal.');
    editingGoal = null;
    return loadGoals();
  }

  // Subtasks go with the goal, so say how many are about to disappear.
  if (e.target.closest('[data-delete-goal]')) {
    const goal = goals.find(g => g.id === id);
    const subtasks = goal && goal.subtasks.length ? ` and its ${goal.subtasks.length} subtask(s)` : '';
    if (!window.confirm(`Delete "${goal ? goal.title : 'this goal'}"${subtasks}? This cannot be undone.`)) return;
    const res = await api(`/api/goals/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) window.alert('Could not delete that goal.');
    return loadGoals();
  }
});

busyBoard.addEventListener('click', async e => {
  const button = e.target.closest('[data-block]');
  if (!button) return;
  if (!window.confirm('Delete this busy block?')) return;
  const res = await api(
    `/api/busy/${encodeURIComponent(button.dataset.date)}/${encodeURIComponent(button.dataset.block)}`,
    { method: 'DELETE' }
  );
  if (!res.ok) window.alert('Could not delete that block.');
  loadBusy();
});

backButton.addEventListener('click', () => {
  showFeed();
  showView(activeView);
});

detailDelete.addEventListener('click', () => {
  if (selectedIndex !== null) deleteNote(selectedIndex);
});

planButton.addEventListener('click', generatePlan);

// Tomorrow by default — the day the nightly job plans — and no way to pick a
// day that has already happened.
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
planDateInput.value = localDay(tomorrow);
planDateInput.min = localDay(new Date());

function openMenu() {
  menuTrigger.classList.add('open');
  menuPanel.classList.add('open');
  topbarEl.classList.add('menu-open');
  menuTrigger.setAttribute('aria-expanded', 'true');
}

function closeMenu() {
  menuTrigger.classList.remove('open');
  menuPanel.classList.remove('open');
  topbarEl.classList.remove('menu-open');
  menuTrigger.setAttribute('aria-expanded', 'false');
}

menuTrigger.addEventListener('click', () => {
  if (menuPanel.classList.contains('open')) closeMenu();
  else openMenu();
});
document.addEventListener('click', e => {
  if (menuPanel.classList.contains('open') && !menuPanel.contains(e.target) && e.target !== menuTrigger) closeMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && menuPanel.classList.contains('open')) closeMenu();
});

logoutButton.addEventListener('click', async () => {
  closeMenu();
  await fetch('/logout', { method: 'POST' });
  window.location.replace('/login');
});

function openInfo() {
  closeMenu();
  infoOverlay.hidden = false;
}

function closeInfo() {
  infoOverlay.hidden = true;
}

infoButton.addEventListener('click', openInfo);
infoClose.addEventListener('click', closeInfo);
infoOverlay.addEventListener('click', e => {
  if (e.target === infoOverlay) closeInfo();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !infoOverlay.hidden) closeInfo();
});

tagFilterEl.addEventListener('click', e => {
  const chip = e.target.closest('.tag-chip');
  if (!chip) return;
  const tag = chip.dataset.tag;
  activeTag = activeTag === tag ? null : tag;
  showFeed();
  loadTags();
  loadNotes();
});

let searchDebounce;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    showFeed();
    loadNotes();
  }, 200);
});

composer.addEventListener('submit', async e => {
  e.preventDefault();
  const text = composerInput.value.trim();
  if (!text) return;
  composerInput.value = '';
  const res = await api('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  // The server declines to guess between equally good goals; without this the
  // dashboard would just show a duplicate appearing, with no hint why.
  const { ambiguous } = await res.json().catch(() => ({}));
  if (ambiguous && ambiguous.length) {
    notify(
      `Saved as its own goal — it could have joined ${ambiguous
        .map(title => `“${title}”`)
        .join(' or ')}.`
    );
  }
  showFeed();
  await loadTags();
  await loadToday();
  await loadBusy();
  await loadGoals();
  await loadNotes();
});

loadWhoami();
loadTags();
loadGoals();
loadBusy();
loadToday().then(loadNotes);

// Pick up notes texted in from your phone, but never yank the feed out from
// under someone who is reading a single entry.
setInterval(() => {
  // Not while a goal is open for editing — reloading would discard the edit.
  if (selectedIndex === null && editingGoal === null) {
    loadToday().then(loadBusy).then(loadGoals).then(loadNotes);
  }
}, 15000);
