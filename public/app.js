const board = document.getElementById('board');
const emptyState = document.getElementById('emptyState');
const searchInput = document.getElementById('search');
const tagFilterEl = document.getElementById('tagFilter');
const composer = document.getElementById('composer');
const composerInput = document.getElementById('composerInput');

let activeTag = null;
let allTags = [];

const TAPE_COLORS = ['#C7D4DD', '#E3C9B6', '#D6DCC1', '#E8D6E3', '#CFE0DD'];
function tapeColorFor(tagName) {
  if (!tagName) return null;
  let hash = 0;
  for (const ch of tagName) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return TAPE_COLORS[hash % TAPE_COLORS.length];
}

function renderBody(entry) {
  const isList = entry.title.toLowerCase().startsWith('list:');
  if (!isList) return escapeHtml(entry.body);
  return entry.body
    .split('\n')
    .map(line => `<span class="list-item">${escapeHtml(line)}</span>`)
    .join('');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderNotes(entries) {
  board.innerHTML = '';
  emptyState.hidden = entries.length > 0;
  entries.forEach((entry, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.setProperty('--tilt', `${(i % 5) - 2}deg`);
    const primaryTag = entry.tags[0];
    if (primaryTag) card.style.setProperty('--tape', tapeColorFor(primaryTag));

    card.innerHTML = `
      <div class="card-meta"><span>${entry.dateTime || ''}</span></div>
      <h3 class="card-title">${escapeHtml(entry.title)}</h3>
      <div class="card-body">${renderBody(entry)}</div>
      <div class="card-tags">
        ${entry.tags.map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join('')}
      </div>
    `;
    board.appendChild(card);
  });
}

async function loadNotes() {
  const params = new URLSearchParams();
  if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
  if (activeTag) params.set('tag', activeTag);
  const res = await fetch(`/api/notes?${params.toString()}`);
  const entries = await res.json();
  renderNotes(entries);
}

async function loadTags() {
  const res = await fetch('/api/tags');
  allTags = await res.json();
  tagFilterEl.innerHTML = allTags
    .map(
      t => `<button class="tag-chip${t.name === activeTag ? ' active' : ''}" style="color:${t.color}" data-tag="${t.name}">${t.name}</button>`
    )
    .join('');
}

tagFilterEl.addEventListener('click', e => {
  const btn = e.target.closest('.tag-chip');
  if (!btn) return;
  const tag = btn.dataset.tag;
  activeTag = activeTag === tag ? null : tag;
  loadTags();
  loadNotes();
});

let searchDebounce;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(loadNotes, 200);
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
  await loadTags();
  await loadNotes();
});

loadTags();
loadNotes();
setInterval(loadNotes, 15000); // pick up notes texted in from your phone
