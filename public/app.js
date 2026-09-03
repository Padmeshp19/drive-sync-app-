const state = {
  path: [{ id: 'root', name: 'My Drive' }],
  selected: new Map(), // id -> { id, name, isFolder }
};

const el = {
  tree: document.getElementById('tree'),
  breadcrumb: document.getElementById('breadcrumb'),
  refreshBtn: document.getElementById('refreshBtn'),
  googlePill: document.getElementById('googlePill'),
  msPill: document.getElementById('msPill'),
  selectedList: document.getElementById('selectedList'),
  syncBtn: document.getElementById('syncBtn'),
  destFolder: document.getElementById('destFolder'),
  progressWrap: document.getElementById('progressWrap'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  log: document.getElementById('log'),
};

async function checkStatus() {
  const res = await fetch('/auth/status').then((r) => r.json());
  setPill(el.googlePill, 'Google', res.google);
  setPill(el.msPill, 'Microsoft', res.microsoft);
  if (res.google) loadFolder('root');
}

function setPill(pillEl, label, connected) {
  pillEl.textContent = connected ? `${label}: connected` : `${label}: connect`;
  pillEl.className = 'pill ' + (connected ? 'connected' : 'disconnected');
  if (!connected) {
    pillEl.onclick = () => {
      window.location.href = label === 'Google' ? '/auth/google' : '/auth/microsoft';
    };
  } else {
    pillEl.onclick = null;
  }
}

async function loadFolder(folderId) {
  el.tree.innerHTML =
    '<li class="tree-item"><span class="name">Loading&hellip;</span></li>';

  try {
    const response = await fetch(
      `/drive/list?parentId=${encodeURIComponent(folderId)}`
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    }

    renderTree(data.files || []);
  } catch (err) {
    console.error('Drive folder load error:', err);

    el.tree.innerHTML = `
      <li class="tree-item">
        <span class="name" style="color:#ff6b6b">
          Failed to load Drive: ${err.message}
        </span>
      </li>
    `;
  }
}

function renderTree(files) {
  el.tree.innerHTML = '';
  renderBreadcrumb();

  if (files.length === 0) {
    el.tree.innerHTML = '<li class="tree-item"><span class="name" style="color:var(--text-dim)">Empty folder</span></li>';
    return;
  }

  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'tree-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(f.id);
    checkbox.onchange = () => {
      if (checkbox.checked) {
        state.selected.set(f.id, { id: f.id, name: f.name, isFolder: f.isFolder });
      } else {
        state.selected.delete(f.id);
      }
      renderSelectedList();
    };

    const name = document.createElement('span');
    name.className = 'name ' + (f.isFolder ? 'folder' : 'file');
    name.textContent = f.name;
    if (f.isFolder) {
      name.onclick = () => {
        state.path.push({ id: f.id, name: f.name });
        loadFolder(f.id);
      };
    }

    li.appendChild(checkbox);
    li.appendChild(name);
    el.tree.appendChild(li);
  }
}

function renderBreadcrumb() {
  el.breadcrumb.innerHTML = '';
  state.path.forEach((p, i) => {
    if (i > 0) el.breadcrumb.appendChild(document.createTextNode(' / '));
    const btn = document.createElement('button');
    btn.textContent = p.name;
    btn.onclick = () => {
      state.path = state.path.slice(0, i + 1);
      loadFolder(p.id);
    };
    el.breadcrumb.appendChild(btn);
  });
}

function renderSelectedList() {
  el.selectedList.innerHTML = '';
  for (const item of state.selected.values()) {
    const row = document.createElement('div');
    row.className = 'sel-item';
    const label = document.createElement('span');
    label.textContent = (item.isFolder ? '📁 ' : '📄 ') + item.name;
    const remove = document.createElement('span');
    remove.textContent = '✕';
    remove.onclick = () => {
      state.selected.delete(item.id);
      renderSelectedList();
      renderTree(Array.from(el.tree.querySelectorAll('.name')).map(() => null)); // no-op, just refresh checkboxes visually
      loadFolder(state.path[state.path.length - 1].id);
    };
    row.appendChild(label);
    row.appendChild(remove);
    el.selectedList.appendChild(row);
  }
  el.syncBtn.disabled = state.selected.size === 0;
  el.syncBtn.textContent = state.selected.size === 0
    ? 'Select items to sync'
    : `Sync ${state.selected.size} item${state.selected.size > 1 ? 's' : ''}`;
}

function addLog(text, cls) {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  el.log.appendChild(li);
  el.log.scrollTop = el.log.scrollHeight;
}

async function startSync() {
  el.syncBtn.disabled = true;
  el.progressWrap.classList.remove('hidden');
  el.progressFill.style.width = '0%';
  el.progressText.textContent = 'Starting sync…';
  el.log.innerHTML = '';

  const items = Array.from(state.selected.values());
  const destFolder = el.destFolder.value.trim() || 'DriveSync';

  const resp = await fetch('/upload/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, destFolder }),
  });

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split('\n\n');
    buffer = events.pop(); // keep incomplete chunk

    for (const evt of events) {
      const lines = evt.split('\n');
      const eventType = lines[0]?.replace('event: ', '');
      const dataLine = lines[1]?.replace('data: ', '');
      if (!dataLine) continue;
      const data = JSON.parse(dataLine);

      if (eventType === 'start') {
        el.progressText.textContent = `0 / ${data.total}`;
      } else if (eventType === 'progress') {
        const pct = Math.round((data.done / data.total) * 100);
        el.progressFill.style.width = pct + '%';
        el.progressText.textContent = `${data.done} / ${data.total}`;
        addLog(`✓ ${data.current}`, 'ok');
      } else if (eventType === 'complete') {
        el.progressText.textContent = `Done — ${data.done} files synced`;
        addLog('Sync complete.', 'ok');
      } else if (eventType === 'error') {
        addLog(`Error: ${data.message}`, 'err');
        el.progressText.textContent = 'Sync failed — see log';
      }
    }
  }

  el.syncBtn.disabled = false;
}

el.refreshBtn.onclick = () => loadFolder(state.path[state.path.length - 1].id);
el.syncBtn.onclick = startSync;

checkStatus();
