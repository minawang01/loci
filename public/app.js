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
const detail = document.getElementById('detail');
const detailMeta = document.getElementById('detailMeta');
const detailTitle = document.getElementById('detailTitle');
const detailItems = document.getElementById('detailItems');
const detailTags = document.getElementById('detailTags');
const backButton = document.getElementById('back');
const detailDelete = document.getElementById('detailDelete');
const logoutButton = document.getElementById('logout');
const searchInput = document.getElementById('search');
const tagFilterEl = document.getElementById('tagFilter');
const composer = document.getElementById('composer');
const composerInput = document.getElementById('composerInput');

const PREVIEW_ITEMS = 4;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let activeTag = null;
let activeView = 'notes';
let entries = [];
let goals = [];
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
    // checkIndex counts checkbox lines only, matching how the server addresses
    // them; a stray non-checkbox line is rendered but not toggleable.
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
          return { text: line.replace(/^[-*]\s*/, ''), done: false, marker: '–', checkIndex: null };
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
      <div class="card-title">${escapeHtml(goal.title || 'Untitled goal')}</div>
      <div class="card-items">${goalSubtaskHtml(goal)}</div>
      <button type="button" class="goal-status" data-status>
        ${goal.status === 'done' ? 'Mark active' : 'Mark complete'}
      </button>
    `;
    goalBoard.appendChild(card);
  });
}

async function loadGoals() {
  const res = await api('/api/goals');
  goals = await res.json();
  renderGoals();
}

function showView(view) {
  activeView = view;
  const notesView = view === 'notes';
  searchEl.hidden = !notesView;
  tagFilterEl.hidden = !notesView;
  board.hidden = !notesView;
  emptyState.hidden = !notesView || entries.length > 0;
  goalBoard.hidden = notesView;
  goalEmpty.hidden = notesView || goals.length > 0;
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
});

backButton.addEventListener('click', () => {
  showFeed();
  showView(activeView);
});

detailDelete.addEventListener('click', () => {
  if (selectedIndex !== null) deleteNote(selectedIndex);
});

logoutButton.addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  window.location.replace('/login');
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
  await api('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  showFeed();
  await loadTags();
  await loadToday();
  await loadGoals();
  await loadNotes();
});

loadTags();
loadGoals();
loadToday().then(loadNotes);

// Pick up notes texted in from your phone, but never yank the feed out from
// under someone who is reading a single entry.
setInterval(() => {
  if (selectedIndex === null) loadToday().then(loadGoals).then(loadNotes);
}, 15000);
