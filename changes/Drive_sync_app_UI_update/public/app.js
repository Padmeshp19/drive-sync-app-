const state = {
  path: [{ id: 'root', name: 'My Drive' }],
  selected: new Map(), // id -> { id, name, isFolder, size }
  sizeRequest: 0,
};

const el = {
  tree: document.getElementById('tree'),
  breadcrumb: document.getElementById('breadcrumb'),
  refreshBtn: document.getElementById('refreshBtn'),
  googlePill: document.getElementById('googlePill'),
  msPill: document.getElementById('msPill'),
  selectedList: document.getElementById('selectedList'),
  selectionSummary: document.getElementById('selectionSummary'),
  selectionSize: document.getElementById('selectionSize'),
  sizeTrackFill: document.getElementById('sizeTrackFill'),
  syncBtn: document.getElementById('syncBtn'),
  destFolder: document.getElementById('destFolder'),
  progressWrap: document.getElementById('progressWrap'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  log: document.getElementById('log'),
  glow: document.getElementById('glow'),
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  const value = bytes / Math.pow(1000, i);
  if (i === 0) return `${Math.round(value)} B`;
  if (value >= 100) return `${value.toFixed(0)} ${units[i]}`;
  if (value >= 10) return `${value.toFixed(1)} ${units[i]}`;
  return `${value.toFixed(2)} ${units[i]}`;
}

async function checkStatus() {
  try {
    const response = await fetch('/auth/status');
    const data = await response.json();

    setPill(el.googlePill, 'Google', data.google);
    setPill(el.msPill, 'Microsoft', data.microsoft);

    if (data.google) {
      loadFolder('root');
    } else {
      el.tree.innerHTML =
        '<li class="tree-item"><span class="name" style="color:var(--text-dim)">Connect Google to browse Drive.</span></li>';
    }
  } catch (err) {
    console.error('Auth status error:', err);
  }
}

function setPill(pillEl, label, connected) {
  pillEl.textContent = connected ? `${label}: connected` : `${label}: connect`;
  pillEl.className = `pill ${connected ? 'connected' : 'disconnected'}`;

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
    '<li class="tree-item"><span class="name" style="color:var(--text-dim)">Loading Drive…</span></li>';

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
        <span class="name" style="color:#fb7185">Failed to load Drive: ${escapeHtml(err.message)}</span>
      </li>
    `;
  }
}

function renderTree(files) {
  el.tree.innerHTML = '';
  renderBreadcrumb();

  if (files.length === 0) {
    el.tree.innerHTML =
      '<li class="tree-item"><span class="name" style="color:var(--text-dim)">This folder is empty.</span></li>';
    return;
  }

  for (const file of files) {
    const li = document.createElement('li');
    li.className = 'tree-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(file.id);
    checkbox.setAttribute(
      'aria-label',
      `Select ${file.name} for sync`
    );

    checkbox.onchange = () => {
      if (checkbox.checked) {
        state.selected.set(file.id, {
          id: file.id,
          name: file.name,
          isFolder: file.isFolder,
          size: file.size,
        });
      } else {
        state.selected.delete(file.id);
      }
      renderSelectedList();
      updateSelectionSize();
    };

    const name = document.createElement('span');
    name.className = `name ${file.isFolder ? 'folder' : 'file'}`;
    name.textContent = file.name;

    if (file.isFolder) {
      name.onclick = () => {
        state.path.push({ id: file.id, name: file.name });
        loadFolder(file.id);
      };
    }

    li.appendChild(checkbox);
    li.appendChild(name);
    el.tree.appendChild(li);
  }
}

function renderBreadcrumb() {
  el.breadcrumb.innerHTML = '';

  state.path.forEach((part, index) => {
    if (index > 0) {
      const slash = document.createElement('span');
      slash.textContent = ' / ';
      slash.style.margin = '0 6px';
      slash.style.color = '#5f5268';
      el.breadcrumb.appendChild(slash);
    }

    const button = document.createElement('button');
    button.textContent = part.name;
    button.onclick = () => {
      state.path = state.path.slice(0, index + 1);
      loadFolder(part.id);
    };

    el.breadcrumb.appendChild(button);
  });
}

function renderSelectedList() {
  el.selectedList.innerHTML = '';

  const items = Array.from(state.selected.values());

  if (items.length === 0) {
    el.selectedList.innerHTML =
      '<div class="empty-selection">Choose something from Google Drive.</div>';
  } else {
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'sel-item';

      const label = document.createElement('span');
      label.className = 'sel-name';
      label.textContent = item.name;
      label.title = item.name;

      const type = document.createElement('span');
      type.className = 'sel-type';
      type.textContent = item.isFolder ? 'FOLDER' : 'FILE';

      const remove = document.createElement('button');
      remove.className = 'sel-remove';
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = `Remove ${item.name}`;
      remove.onclick = () => {
        state.selected.delete(item.id);
        renderSelectedList();
        updateVisibleCheckboxes();
        updateSelectionSize();
      };

      row.appendChild(label);
      row.appendChild(type);
      row.appendChild(remove);
      el.selectedList.appendChild(row);
    }
  }

  const count = items.length;
  el.selectionSummary.textContent =
    count === 0
      ? 'Nothing selected'
      : `${count} item${count === 1 ? '' : 's'} selected`;

  el.syncBtn.disabled = count === 0;
  setSyncButtonText();
}

function updateVisibleCheckboxes() {
  el.tree.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    const nameEl = checkbox.parentElement?.querySelector('.name');
    if (!nameEl) return;

    const visibleName = nameEl.textContent;
    const match = Array.from(state.selected.values()).find(
      (item) => item.name === visibleName
    );

    if (match) checkbox.checked = true;
  });

  // Reloading the current folder guarantees exact checkbox state when duplicate names exist.
  loadFolder(state.path[state.path.length - 1].id);
}

async function updateSelectionSize() {
  const items = Array.from(state.selected.values());
  const requestId = ++state.sizeRequest;

  if (items.length === 0) {
    el.selectionSize.textContent = '0 GB';
    el.sizeTrackFill.style.width = '0%';
    setSyncButtonText();
    return;
  }

  el.selectionSize.textContent = 'Calculating…';
  el.sizeTrackFill.style.width = '35%';
  setSyncButtonText();

  try {
    const response = await fetch('/drive/selection-size', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: items.map(({ id, isFolder }) => ({ id, isFolder })),
      }),
    });

    const data = await response.json();

    if (requestId !== state.sizeRequest) return;

    if (!response.ok) {
      throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    }

    state.selectionStats = data;
    el.selectionSize.textContent = formatBytes(Number(data.totalBytes) || 0);
    el.sizeTrackFill.style.width = data.fileCount > 0 ? '100%' : '0%';

    if (data.unknownSizeCount > 0) {
      el.selectionSummary.textContent =
        `${items.length} item${items.length === 1 ? '' : 's'} · ${data.fileCount} file${data.fileCount === 1 ? '' : 's'} · ${data.unknownSizeCount} without size`;
    } else {
      el.selectionSummary.textContent =
        `${items.length} item${items.length === 1 ? '' : 's'} · ${data.fileCount} file${data.fileCount === 1 ? '' : 's'}`;
    }

    setSyncButtonText();
  } catch (err) {
    if (requestId !== state.sizeRequest) return;
    console.error('Selection size error:', err);
    state.selectionStats = null;
    el.selectionSize.textContent = 'Size unavailable';
    el.sizeTrackFill.style.width = '0%';
    setSyncButtonText();
  }
}

function setSyncButtonText() {
  const items = Array.from(state.selected.values());

  if (items.length === 0) {
    el.syncBtn.innerHTML =
      '<span>Select items to sync</span><span class="btn-arrow">→</span>';
    return;
  }

  const stats = state.selectionStats;
  const size = stats && Number.isFinite(Number(stats.totalBytes))
    ? formatBytes(Number(stats.totalBytes))
    : '…';

  el.syncBtn.innerHTML =
    `<span>Sync ${size} → OneDrive</span><span class="btn-arrow">→</span>`;
}

function addLog(text, cls) {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  el.log.appendChild(li);
  el.log.scrollTop = el.log.scrollHeight;
}

async function startSync() {
  const items = Array.from(state.selected.values());
  if (items.length === 0) return;

  el.syncBtn.disabled = true;
  el.progressWrap.classList.remove('hidden');
  el.progressFill.style.width = '0%';
  el.progressText.textContent = 'Starting…';
  el.log.innerHTML = '';

  const destFolder = el.destFolder.value.trim() || 'DriveSync';

  try {
    const resp = await fetch('/upload/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, destFolder }),
    });

    if (!resp.ok || !resp.body) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.detail || data.error || `HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();

      for (const evt of events) {
        const lines = evt.split('\n');
        const eventType = lines[0]?.replace('event: ', '');
        const dataLine = lines[1]?.replace('data: ', '');
        if (!dataLine) continue;

        const data = JSON.parse(dataLine);

        if (eventType === 'start') {
          el.progressText.textContent = `0 / ${data.total}`;
        } else if (eventType === 'progress') {
          const pct = data.total
            ? Math.round((data.done / data.total) * 100)
            : 100;
          el.progressFill.style.width = `${pct}%`;
          el.progressText.textContent = `${data.done} / ${data.total}`;
          addLog(`✓ ${data.current}`, 'ok');
        } else if (eventType === 'complete') {
          el.progressFill.style.width = '100%';
          el.progressText.textContent = `Done — ${data.done} files synced`;
          addLog('Sync complete.', 'ok');
        } else if (eventType === 'error') {
          addLog(`Error: ${data.message}`, 'err');
          el.progressText.textContent = 'Sync failed — see log';
        }
      }
    }
  } catch (err) {
    console.error('Sync error:', err);
    addLog(`Error: ${err.message}`, 'err');
    el.progressText.textContent = 'Sync failed — see log';
  } finally {
    el.syncBtn.disabled = state.selected.size === 0;
    setSyncButtonText();
  }
}

el.refreshBtn.onclick = () => {
  loadFolder(state.path[state.path.length - 1].id);
};

el.syncBtn.onclick = startSync;

document.addEventListener('mousemove', (event) => {
  if (!el.glow) return;
  el.glow.style.left = `${event.clientX}px`;
  el.glow.style.top = `${event.clientY}px`;
});

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

checkStatus();
renderSelectedList();
