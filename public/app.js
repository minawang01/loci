const board = document.getElementById('board');
const emptyState = document.getElementById('emptyState');
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
const searchInput = document.getElementById('search');
const tagFilterEl = document.getElementById('tagFilter');
const composer = document.getElementById('composer');
const composerInput = document.getElementById('composerInput');

const PREVIEW_ITEMS = 4;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let activeTag = null;
let entries = [];
let selectedIndex = null;
let todayListTitle = null;

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
    return {
      ...stamp,
      title: entry.title.replace(/^list:\s*/i, ''),
      tags: entry.tags,
      items: lines.map(line => {
        const checkbox = /^-\s*\[([ xX])\]\s*(.*)$/.exec(line);
        if (!checkbox) return { text: line.replace(/^-\s*/, ''), done: false, marker: '–' };
        const done = checkbox[1].toLowerCase() === 'x';
        return { text: checkbox[2], done, marker: done ? '✓' : '–' };
      })
    };
  }

  return {
    ...stamp,
    title: lines[0] || '',
    tags: entry.tags,
    items: lines.slice(1).map(text => ({ text, done: false, marker: '' }))
  };
}

function itemHtml(item) {
  return `
    <div class="item${item.done ? ' done' : ''}">
      ${item.marker ? `<span class="marker">${item.marker}</span>` : ''}
      <span class="text">${escapeHtml(item.text)}</span>
    </div>`;
}

function renderFeed() {
  board.innerHTML = '';
  emptyState.hidden = entries.length > 0;

  entries.forEach((raw, index) => {
    const entry = shapeEntry(raw);
    const hidden = Math.max(0, entry.items.length - PREVIEW_ITEMS);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.dataset.index = index;
    card.innerHTML = `
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
  const res = await fetch(`/api/notes?${params.toString()}`);
  const all = await res.json();
  // Today's todo list has its own column, so keep it out of the feed — but
  // leave it in search and tag results, where hiding a match would be wrong.
  const filtering = params.has('q') || params.has('tag');
  entries = filtering ? all : all.filter(entry => entry.title !== todayListTitle);
  renderFeed();
}

async function loadToday() {
  const res = await fetch('/api/todos/today');
  const { name, entry } = await res.json();
  todayListTitle = `List: ${name}`;
  todayDateEl.textContent = formatStamp(`${name.replace(/^Todo\s*/, '')} 00:00`).date;

  const items = entry ? shapeEntry(entry).items : [];
  todayItemsEl.innerHTML = items.map(itemHtml).join('');
  todayEmptyEl.hidden = items.length > 0;
}

async function loadTags() {
  const res = await fetch('/api/tags');
  const tags = await res.json();
  tagFilterEl.innerHTML = tags
    .map(
      tag =>
        `<button type="button" class="tag-chip${tag.name === activeTag ? ' active' : ''}" data-tag="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}</button>`
    )
    .join('');
}

board.addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (card) showDetail(Number(card.dataset.index));
});

backButton.addEventListener('click', showFeed);

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
  await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  showFeed();
  await loadTags();
  await loadToday();
  await loadNotes();
});

loadTags();
loadToday().then(loadNotes);

// Pick up notes texted in from your phone, but never yank the feed out from
// under someone who is reading a single entry.
setInterval(() => {
  if (selectedIndex === null) loadToday().then(loadNotes);
}, 15000);
