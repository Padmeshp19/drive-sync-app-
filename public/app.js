const state = {
  path: [{ id: 'root', name: 'My Drive' }],
  selected: new Map(), // id -> { id, name, isFolder, size }
  sizeRequest: 0,
  folderRequest: 0,
  folderCache: new Map(),
  folderController: null,
  searchRequest: 0,
  searchController: null,
  searchQuery: '',
  searchResults: [],
  searchNextPageToken: null,
  selectAllBusy: false,
  selectAllController: null,
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
  trashBtn: document.getElementById('trashBtn'),
  destFolder: document.getElementById('destFolder'),
  progressWrap: document.getElementById('progressWrap'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  log: document.getElementById('log'),
  glow: document.getElementById('glow'),
  driveSearch: document.getElementById('driveSearch'),
  clearSearchBtn: document.getElementById('clearSearchBtn'),
  selectAllBtn: document.getElementById('selectAllBtn'),
  titleType: document.getElementById('titleType'),
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

async function loadFolder(folderId, options = {}) {
  state.searchQuery = '';
  state.searchResults = [];
  state.searchNextPageToken = null;
  if (el.driveSearch) el.driveSearch.value = '';
  if (el.clearSearchBtn) el.clearSearchBtn.classList.add('hidden');
  if (state.searchController) state.searchController.abort();

  const requestId = ++state.folderRequest;
  const cached = state.folderCache.get(folderId);

  if (state.folderController) state.folderController.abort();

  if (!options.force && cached) {
    renderTree(cached.files || [], cached.nextPageToken, folderId);
    return;
  }

  state.folderController = new AbortController();
  el.tree.innerHTML =
    '<li class="tree-item loading-row"><span class="loading-dot"></span><span class="name" style="color:var(--text-dim)">Loading Drive…</span></li>';

  try {
    const response = await fetch(
      `/drive/list?parentId=${encodeURIComponent(folderId)}`,
      { signal: state.folderController.signal }
    );
    const data = await response.json();

    if (requestId !== state.folderRequest) return;
    if (!response.ok) {
      throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    }

    state.folderCache.set(folderId, data);
    renderTree(data.files || [], data.nextPageToken, folderId);
  } catch (err) {
    if (err.name === 'AbortError' || requestId !== state.folderRequest) return;
    console.error('Drive folder load error:', err);
    el.tree.innerHTML = `
      <li class="tree-item">
        <span class="name" style="color:#fb7185">Failed to load Drive: ${escapeHtml(err.message)}</span>
      </li>
    `;
  }
}

function currentVisibleFiles() {
  if (state.searchQuery) return state.searchResults;
  const cached = state.folderCache.get(folderIdForCurrentPath());
  return cached?.files || [];
}

function updateSelectAllButton() {
  if (!el.selectAllBtn) return;

  const files = currentVisibleFiles();
  const selectedCount = files.filter((file) => state.selected.has(file.id)).length;
  const allSelected = files.length > 0 && selectedCount === files.length;
  const someSelected = selectedCount > 0 && !allSelected;

  el.selectAllBtn.textContent = allSelected ? 'Clear all' : 'Select all';
  el.selectAllBtn.classList.toggle('active', allSelected);
  el.selectAllBtn.classList.toggle('partial', someSelected);
  el.selectAllBtn.setAttribute('aria-pressed', String(allSelected));
  el.selectAllBtn.disabled = files.length === 0;
}

async function fetchAllFolderItems(folderId, signal) {
  const all = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ parentId: folderId });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`/drive/list?${params.toString()}`, { signal });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    }
    all.push(...(data.files || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return all;
}

async function fetchAllSearchItems(signal) {
  const all = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ q: state.searchQuery });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`/drive/search?${params.toString()}`, { signal });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    }
    all.push(...(data.files || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return all;
}

async function selectAllCurrentView() {
  if (!el.selectAllBtn || state.selectAllBusy) return;

  const initial = currentVisibleFiles();
  if (initial.length === 0) return;

  const alreadyFullyLoaded = state.searchQuery
    ? !state.searchNextPageToken
    : !(state.folderCache.get(folderIdForCurrentPath())?.nextPageToken);
  const allKnownSelected = initial.every((file) => state.selected.has(file.id));

  if (alreadyFullyLoaded && allKnownSelected) {
    initial.forEach((file) => state.selected.delete(file.id));
    state.selectionStats = null;
    renderSelectedList();
    updateVisibleCheckboxes();
    updateSelectionSize();
    updateSelectAllButton();
    return;
  }

  state.selectAllBusy = true;
  el.selectAllBtn.disabled = true;
  el.selectAllBtn.textContent = 'Selecting…';
  if (state.selectAllController) state.selectAllController.abort();
  state.selectAllController = new AbortController();

  try {
    const all = state.searchQuery
      ? await fetchAllSearchItems(state.selectAllController.signal)
      : await fetchAllFolderItems(folderIdForCurrentPath(), state.selectAllController.signal);

    if (!state.searchQuery) {
      const folderId = folderIdForCurrentPath();
      state.folderCache.set(folderId, { files: all, nextPageToken: null });
    } else {
      state.searchResults = all;
      state.searchNextPageToken = null;
    }

    all.forEach((file) => {
      state.selected.set(file.id, {
        id: file.id,
        name: file.name,
        isFolder: file.isFolder,
        size: file.size,
      });
    });

    if (state.searchQuery) renderSearchResults();
    else renderTree(all, null, folderIdForCurrentPath());

    renderSelectedList();
    updateSelectionSize();
    updateSelectAllButton();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Select all error:', err);
      el.selectAllBtn.textContent = 'Select all';
    }
  } finally {
    state.selectAllBusy = false;
    state.selectAllController = null;
    updateSelectAllButton();
  }
}

function renderTree(files, nextPageToken = null, folderId = folderIdForCurrentPath()) {
  el.tree.innerHTML = '';
  renderBreadcrumb();

  if (files.length === 0) {
    el.tree.innerHTML =
      '<li class="tree-item"><span class="name" style="color:var(--text-dim)">This folder is empty.</span></li>';
    updateSelectAllButton();
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
    checkbox.dataset.fileId = file.id;

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
      updateSelectAllButton();
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

  if (nextPageToken) {
    const more = document.createElement('li');
    more.className = 'tree-item load-more-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'load-more';
    button.textContent = 'Load more items';
    button.onclick = () => loadMore(folderId, nextPageToken);
    more.appendChild(document.createElement('span'));
    more.appendChild(button);
    el.tree.appendChild(more);
  }

  updateSelectAllButton();
}

function folderIdForCurrentPath() {
  return state.path[state.path.length - 1].id;
}

async function loadMore(folderId, pageToken) {
  try {
    const response = await fetch(
      `/drive/list?parentId=${encodeURIComponent(folderId)}&pageToken=${encodeURIComponent(pageToken)}`
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    }
    const cached = state.folderCache.get(folderId) || { files: [] };
    const merged = {
      files: [...(cached.files || []), ...(data.files || [])],
      nextPageToken: data.nextPageToken || null,
    };
    state.folderCache.set(folderId, merged);
    renderTree(merged.files, merged.nextPageToken, folderId);
  } catch (err) {
    console.error('Load more error:', err);
  }
}


async function searchDrive(query, options = {}) {
  const term = String(query || '').trim();

  if (term.length < 2) {
    clearDriveSearch(false);
    return;
  }

  if (state.searchController) state.searchController.abort();
  if (state.folderController) state.folderController.abort();

  const requestId = ++state.searchRequest;
  state.searchQuery = term;
  if (!options.append) state.searchResults = [];
  if (!options.append) state.searchNextPageToken = null;
  if (el.clearSearchBtn) el.clearSearchBtn.classList.remove('hidden');

  if (!options.append) {
    el.tree.innerHTML =
      '<li class="tree-item loading-row"><span class="loading-dot"></span><span class="name" style="color:var(--text-dim)">Searching Google Drive…</span></li>';
  }

  state.searchController = new AbortController();

  try {
    const params = new URLSearchParams({ q: term });
    if (options.pageToken) params.set('pageToken', options.pageToken);

    const response = await fetch(`/drive/search?${params.toString()}`, {
      signal: state.searchController.signal,
    });
    const data = await response.json();

    if (requestId !== state.searchRequest) return;
    if (!response.ok) {
      throw new Error(data.detail || data.error || `HTTP ${response.status}`);
    }

    if (options.append) {
      state.searchResults.push(...(data.files || []));
    } else {
      state.searchResults = data.files || [];
    }
    state.searchNextPageToken = data.nextPageToken || null;
    renderSearchResults();
  } catch (err) {
    if (err.name === 'AbortError' || requestId !== state.searchRequest) return;
    console.error('Drive search error:', err);
    el.tree.innerHTML = `
      <li class="tree-item">
        <span class="name" style="color:#fb7185">Search failed: ${escapeHtml(err.message)}</span>
      </li>
    `;
  }
}

function renderSearchResults() {
  el.tree.innerHTML = '';
  el.breadcrumb.innerHTML = '';

  const label = document.createElement('span');
  label.className = 'search-results-label';
  label.textContent = `Search results for “${state.searchQuery}”`;
  el.breadcrumb.appendChild(label);

  if (state.searchResults.length === 0) {
    el.tree.innerHTML =
      '<li class="tree-item"><span class="name" style="color:var(--text-dim)">No matching files or folders found.</span></li>';
    updateSelectAllButton();
    return;
  }

  for (const file of state.searchResults) {
    const li = document.createElement('li');
    li.className = 'tree-item search-result-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(file.id);
    checkbox.dataset.fileId = file.id;
    checkbox.setAttribute('aria-label', `Select ${file.name} for sync`);
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
      updateSelectAllButton();
    };

    const name = document.createElement('span');
    name.className = `name ${file.isFolder ? 'folder' : 'file'}`;
    name.textContent = file.name;
    name.title = file.name;

    if (file.isFolder) {
      name.onclick = () => {
        state.path = [{ id: 'root', name: 'My Drive' }, { id: file.id, name: file.name }];
        loadFolder(file.id);
      };
    }

    const meta = document.createElement('span');
    meta.className = 'search-result-meta';
    meta.textContent = file.isFolder ? 'FOLDER' : (file.size ? formatBytes(Number(file.size)) : 'FILE');

    li.appendChild(checkbox);
    li.appendChild(name);
    li.appendChild(meta);
    el.tree.appendChild(li);
  }

  if (state.searchNextPageToken) {
    const more = document.createElement('li');
    more.className = 'tree-item load-more-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'load-more';
    button.textContent = 'Load more results';
    button.onclick = () => searchDrive(state.searchQuery, {
      append: true,
      pageToken: state.searchNextPageToken,
    });
    more.appendChild(document.createElement('span'));
    more.appendChild(button);
    el.tree.appendChild(more);
  }

  updateSelectAllButton();
}

function clearDriveSearch(loadCurrentFolder = true) {
  if (state.searchController) state.searchController.abort();
  state.searchRequest += 1;
  state.searchQuery = '';
  state.searchResults = [];
  state.searchNextPageToken = null;
  if (el.driveSearch) el.driveSearch.value = '';
  if (el.clearSearchBtn) el.clearSearchBtn.classList.add('hidden');
  if (loadCurrentFolder) loadFolder(folderIdForCurrentPath());
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
        updateSelectAllButton();
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
  el.trashBtn.disabled = count === 0;
  setSyncButtonText();
}

function updateVisibleCheckboxes() {
  el.tree.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.checked = state.selected.has(checkbox.dataset.fileId);
  });
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

async function moveSelectedToTrash() {
  const items = Array.from(state.selected.values());
  if (items.length === 0) return;

  const folderCount = items.filter((item) => item.isFolder).length;
  const fileCount = items.length - folderCount;
  const parts = [];
  if (fileCount) parts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
  if (folderCount) parts.push(`${folderCount} folder${folderCount === 1 ? '' : 's'}`);

  const confirmed = window.confirm(
    `Move ${parts.join(' and ')} to Google Drive Trash?\n\n` +
    `This removes the selected item${items.length === 1 ? '' : 's'} from My Drive. ` +
    `You can restore them from Google Drive Trash.`
  );

  if (!confirmed) return;

  el.syncBtn.disabled = true;
  el.trashBtn.disabled = true;
  el.progressWrap.classList.remove('hidden');
  el.progressFill.style.width = '0%';
  el.progressText.textContent = `Moving 0 / ${items.length} to Trash`;
  el.log.innerHTML = '';

  try {
    const resp = await fetch('/drive/trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: items.map(({ id, name, isFolder }) => ({ id, name, isFolder })),
      }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      throw new Error(data.detail || data.error || `HTTP ${resp.status}`);
    }

    for (const result of data.results || []) {
      if (result.success) {
        addLog(`✓ Moved to Trash: ${result.name}`, 'ok');
        state.selected.delete(result.id);
      } else {
        addLog(`Error: ${result.name} — ${result.error}`, 'err');
      }
    }

    const moved = Number(data.trashed) || 0;
    const failed = Number(data.failed) || 0;
    el.progressFill.style.width = items.length ? `${Math.round(((moved + failed) / items.length) * 100)}%` : '100%';
    el.progressText.textContent = failed
      ? `Done — ${moved} moved, ${failed} failed`
      : `Done — ${moved} item${moved === 1 ? '' : 's'} moved to Trash`;

    // Drive listings and selection sizes are now stale, so refresh them.
    state.folderCache.clear();
    state.selectionStats = null;
    renderSelectedList();
    await loadFolder(folderIdForCurrentPath(), { force: true });
    updateSelectionSize();
  } catch (err) {
    console.error('Drive trash error:', err);
    addLog(`Error: ${err.message}`, 'err');
    el.progressText.textContent = 'Delete failed — see log';
  } finally {
    el.syncBtn.disabled = state.selected.size === 0;
    el.trashBtn.disabled = state.selected.size === 0;
    setSyncButtonText();
  }
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
  state.folderCache.delete(folderIdForCurrentPath());
  loadFolder(folderIdForCurrentPath(), { force: true });
};

el.syncBtn.onclick = startSync;
el.trashBtn.onclick = moveSelectedToTrash;
el.selectAllBtn?.addEventListener('click', selectAllCurrentView);

let searchTimer = null;
el.driveSearch?.addEventListener('input', () => {
  const term = el.driveSearch.value.trim();
  if (el.clearSearchBtn) el.clearSearchBtn.classList.toggle('hidden', term.length === 0);
  clearTimeout(searchTimer);

  if (term.length === 0) {
    clearDriveSearch(true);
    return;
  }

  if (term.length < 2) return;
  searchTimer = setTimeout(() => searchDrive(term), 300);
});

el.driveSearch?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    clearTimeout(searchTimer);
    searchDrive(el.driveSearch.value);
  }
});

el.clearSearchBtn?.addEventListener('click', () => clearDriveSearch(true));

let glowFrame = 0;
let glowX = 0;
let glowY = 0;

document.addEventListener('mousemove', (event) => {
  if (!el.glow) return;
  glowX = event.clientX;
  glowY = event.clientY;
  if (glowFrame) return;
  glowFrame = requestAnimationFrame(() => {
    el.glow.style.left = '0';
    el.glow.style.top = '0';
    el.glow.style.transform = `translate3d(${glowX}px, ${glowY}px, 0) translate(-50%, -50%)`;
    glowFrame = 0;
  });
});

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

/* NoteVault-style title animation: slide the first line, then type the second. */
const titleText = 'Without the mess.';
let titleIndex = 0;
function typeMainTitle() {
  if (!el.titleType) return;
  if (titleIndex < titleText.length) {
    el.titleType.textContent += titleText[titleIndex];
    titleIndex += 1;
    setTimeout(typeMainTitle, 45);
  } else {
    el.titleType.classList.add('typed');
  }
}
setTimeout(typeMainTitle, 1200);

checkStatus();
renderSelectedList();
