// The page menu as a tree of folders (FORK.md 页的文件夹). One canvas carries every session's
// pages (50 on 2026-10-22), and tldraw's page menu lists them in one long column. A page's
// folder is meta.cowartFolder on its page record ("数码宝贝/参考", the service's
// page-folders.mjs); sessions sort pages into folders when the user asks, this menu only shows
// them (the user chose that over sorting by hand here). The page menu button opens this menu
// instead of tldraw's: a search box, folders that fold, the pages with who is responsible for
// each, and the page actions tldraw's menu had (new page, rename, duplicate, delete);
// reordering by dragging went with it. Three orders: the canvas's (pages as they were made),
// 最近改过 (one list, the page changed last on top, from the service's page-activity.mjs) and
// by name (numbers by value: 参考 2 before 参考 10).
(() => {
  'use strict'
  const kit = window.__cowartKit
  if (!kit || window.__cowartPageTree) return
  window.__cowartPageTree = true

  const FOLDER_KEY = 'cowartFolder'
  // Folders this viewer unfolded, kept in the browser (a per-viewer convenience).
  const OPEN_KEY = 'cowart.pageTree.openFolders'
  const SORT_KEY = 'cowart.pageTree.sort'
  const SORTS = [
    { id: 'canvas', label: '建页先后' },
    { id: 'recent', label: '最近改过' },
    { id: 'name', label: '按名称' }
  ]
  // Like the file explorer: names in Latin letters and digits first (A to Z), then Chinese ones by
  // pinyin; the zh collation alone puts every Chinese name first.
  const latinOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare
  const pinyinOrder = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' }).compare
  const latin = (name) => /^[ -~]/.test(name) // starts with printable ASCII
  const byName = (a, b) => (latin(a) !== latin(b) ? (latin(a) ? -1 : 1) : (latin(a) ? latinOrder : pinyinOrder)(a, b))
  const TRIGGER = '.tlui-page-menu__trigger'
  const REFRESH_MS = 400
  const INDENT = 14

  const icon = (paths, size = 14) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  const ICON = {
    chevron: icon('<path d="M9 6l6 6-6 6"/>', 12),
    folder: icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    page: icon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    search: icon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
    more: icon('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>'),
    plus: icon('<path d="M12 5v14M5 12h14"/>'),
    sort: icon('<path d="M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3"/>'),
    check: icon('<path d="M5 12l5 5L20 7"/>', 12)
  }

  // On the body, above what the page scripts float over the canvas (AI panels 2147481000, video
  // controls 2147482000) and below the status bar at the top (2147483000): inside tldraw's
  // container it could not be, the canvas sits in a fixed <main>, a stacking context of its own.
  // tldraw's theme colors are copied over from its container when the menu opens.
  const THEME_VARS = ['--tl-color-text-1', '--tl-color-text-3', '--tl-color-panel', '--tl-color-low', '--tl-color-muted-2', '--tl-color-hint', '--tl-color-selected', '--tl-color-divider', '--tl-color-danger', '--tl-radius-1', '--tl-radius-2', '--tl-radius-3', '--tl-shadow-2', '--tl-shadow-3']
  const style = document.createElement('style')
  style.id = 'cowart-page-tree'
  style.textContent = `
    .cowart-page-tree:focus { outline: none; }
    .cowart-page-tree { position: fixed; z-index: 2147482500; display: flex; flex-direction: column; width: 320px;
      max-width: calc(100vw - 16px); color: var(--tl-color-text-1); font-size: 12px; background: var(--tl-color-panel);
      border-radius: var(--tl-radius-3); box-shadow: var(--tl-shadow-3); pointer-events: all; }
    .cowart-page-tree * { box-sizing: border-box; }
    .cowart-page-tree .search { display: flex; align-items: center; gap: 6px; padding: 0 8px; height: 32px;
      color: var(--tl-color-text-3); background: var(--tl-color-low); border-radius: var(--tl-radius-2); }
    .cowart-page-tree .search input { flex: 1; min-width: 0; height: 100%; padding: 0; color: var(--tl-color-text-1); font: inherit;
      background: transparent; border: 0; outline: 0; }
    .cowart-page-tree .top { display: flex; align-items: center; gap: 4px; margin: 6px 6px 2px; }
    .cowart-page-tree .top .search { flex: 1; min-width: 0; }
    .cowart-page-tree .sort { flex: none; display: flex; align-items: center; gap: 4px; height: 32px; padding: 0 8px; color: var(--tl-color-text-3);
      font: inherit; white-space: nowrap; background: transparent; border: 0; border-radius: var(--tl-radius-2); cursor: pointer; }
    .cowart-page-tree .sort:hover, .cowart-page-tree .sort[aria-expanded='true'] { color: var(--tl-color-text-1); background: var(--tl-color-muted-2); }
    .cowart-page-tree .sorts { position: absolute; top: 42px; right: 6px; z-index: 1; min-width: 120px; padding: 4px; background: var(--tl-color-panel);
      border-radius: var(--tl-radius-3); box-shadow: var(--tl-shadow-2); }
    .cowart-page-tree .sorts button { display: flex; align-items: center; gap: 6px; width: 100%; height: 30px; padding: 0 10px; color: var(--tl-color-text-1);
      font: inherit; text-align: start; background: transparent; border: 0; border-radius: var(--tl-radius-2); cursor: pointer; }
    .cowart-page-tree .sorts button:hover { background: var(--tl-color-muted-2); }
    .cowart-page-tree .sorts .tick { display: flex; width: 12px; }
    .cowart-page-tree .time { flex: none; color: var(--tl-color-text-3); }
    .cowart-page-tree .divider { margin-top: 4px; padding: 8px 10px 4px; color: var(--tl-color-text-3); border-top: 1px solid var(--tl-color-divider); }
    .cowart-page-tree .list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px 4px 4px; }
    .cowart-page-tree .row { position: relative; display: flex; align-items: center; gap: 6px; min-height: 32px; padding: 2px 4px 2px 0;
      border-radius: var(--tl-radius-2); cursor: pointer; user-select: none; }
    .cowart-page-tree .row:hover, .cowart-page-tree .row.active { background: var(--tl-color-muted-2); }
    .cowart-page-tree .row.current { background: var(--tl-color-hint); }
    .cowart-page-tree .row.current .label { font-weight: bold; }
    .cowart-page-tree .chev { flex: none; display: flex; width: 12px; color: var(--tl-color-text-3); transition: transform 0.08s ease-out; }
    .cowart-page-tree .row.open .chev { transform: rotate(90deg); }
    .cowart-page-tree .kind { flex: none; display: flex; color: var(--tl-color-text-3); }
    .cowart-page-tree .label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cowart-page-tree .stack { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; line-height: 1.35; }
    .cowart-page-tree .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--tl-color-text-3); font-size: 11px; }
    .cowart-page-tree .count { flex: none; color: var(--tl-color-text-3); }
    .cowart-page-tree .who { flex: none; max-width: 40%; padding: 1px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--tl-color-text-3); background: var(--tl-color-muted-2); border-radius: var(--tl-radius-1); }
    .cowart-page-tree .row.current .who { background: var(--tl-color-panel); }
    .cowart-page-tree .more { flex: none; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0;
      color: var(--tl-color-text-3); background: transparent; border: 0; border-radius: var(--tl-radius-1); cursor: pointer; visibility: hidden; }
    .cowart-page-tree .row:hover .more, .cowart-page-tree .row.menu-open .more { visibility: visible; }
    .cowart-page-tree .more:hover { color: var(--tl-color-text-1); background: var(--tl-color-panel); }
    .cowart-page-tree .rename { flex: 1; min-width: 0; height: 26px; padding: 0 6px; color: var(--tl-color-text-1); font: inherit;
      background: var(--tl-color-panel); border: 1px solid var(--tl-color-selected); border-radius: var(--tl-radius-1); outline: 0; }
    .cowart-page-tree .empty, .cowart-page-tree .hint { padding: 8px 10px; color: var(--tl-color-text-3); line-height: 1.5; }
    .cowart-page-tree .footer { display: flex; align-items: center; padding: 4px; border-top: 1px solid var(--tl-color-divider); }
    .cowart-page-tree .create { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 32px; padding: 0 8px;
      color: var(--tl-color-text-1); font: inherit; background: transparent; border: 0; border-radius: var(--tl-radius-2); cursor: pointer; }
    .cowart-page-tree .create:hover { background: var(--tl-color-muted-2); }
    .cowart-page-tree .actions { position: absolute; z-index: 1; min-width: 120px; padding: 4px; background: var(--tl-color-panel);
      border-radius: var(--tl-radius-3); box-shadow: var(--tl-shadow-2); }
    .cowart-page-tree .actions button { display: block; width: 100%; height: 30px; padding: 0 10px; color: var(--tl-color-text-1); font: inherit;
      text-align: start; background: transparent; border: 0; border-radius: var(--tl-radius-2); cursor: pointer; }
    .cowart-page-tree .actions button:hover { background: var(--tl-color-muted-2); }
    .cowart-page-tree .actions button.danger { color: var(--tl-color-danger); }
    ${TRIGGER}[data-cowart-open='true']::after { background: linear-gradient(180deg, rgba(144, 144, 144, 0) 0%, var(--tl-color-muted-2) 100%); opacity: 1; }
  `
  document.head.appendChild(style)

  // ---- The tree ------------------------------------------------------------------------

  function folderOf(page) {
    const value = page && page.meta ? page.meta[FOLDER_KEY] : null
    if (typeof value !== 'string') return ''
    return value.split(/[/\\／]/).map((name) => name.trim()).filter(Boolean).join('/')
  }

  // Each level lists its folders first, then its pages, both in the pages' canvas order (as the
  // service's pageTree does) or by name.
  function buildTree(pages, sort) {
    const root = { path: '', count: 0, children: [], folders: new Map() }
    for (const page of pages) {
      let node = root
      for (const name of folderOf(page).split('/').filter(Boolean)) {
        let child = node.folders.get(name)
        if (!child) {
          child = { name, path: node.path ? `${node.path}/${name}` : name, count: 0, children: [], folders: new Map() }
          node.folders.set(name, child)
          node.children.push({ folder: child })
        }
        child.count += 1
        node = child
      }
      node.children.push({ page })
    }
    const named = (list, nameOf) => (sort === 'name' ? [...list].sort((a, b) => byName(nameOf(a), nameOf(b))) : list)
    const foldersFirst = (node) => {
      node.children = [
        ...named(node.children.filter((child) => child.folder), (child) => child.folder.name),
        ...named(node.children.filter((child) => child.page), (child) => child.page.name)
      ]
      for (const child of node.children) if (child.folder) foldersFirst(child.folder)
    }
    foldersFirst(root)
    return root
  }

  function ancestorsOf(folder) {
    const names = folder.split('/').filter(Boolean)
    return names.map((_, index) => names.slice(0, index + 1).join('/'))
  }

  function readOpenFolders() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(OPEN_KEY) || '[]')
      return new Set(Array.isArray(saved) ? saved.filter((entry) => typeof entry === 'string') : [])
    } catch {
      return new Set()
    }
  }

  function readSort() {
    try {
      const saved = window.localStorage.getItem(SORT_KEY)
      return SORTS.some((entry) => entry.id === saved) ? saved : 'canvas'
    } catch {
      return 'canvas'
    }
  }

  function setSort(next) {
    sort = next
    sortsOpen = false
    active = -1
    try {
      window.localStorage.setItem(SORT_KEY, next)
    } catch {
      // Back to the canvas order on the next load.
    }
    render()
    root.querySelector('.list').scrollTop = 0
  }

  function changedAt() {
    return window.__cowartPageChangedAt || {}
  }

  // 刚刚 / 5 分钟前 / 3 小时前 / 昨天 / 4 天前 / 10-15.
  function ago(at) {
    const minutes = Math.floor((Date.now() - at) / 60000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes} 分钟前`
    const day = (time) => new Date(time).setHours(0, 0, 0, 0)
    const days = Math.round((day(Date.now()) - day(at)) / 86400000)
    if (days === 0) return `${Math.floor(minutes / 60)} 小时前`
    if (days === 1) return '昨天'
    if (days < 7) return `${days} 天前`
    const date = new Date(at)
    return `${date.getMonth() + 1}-${date.getDate()}`
  }

  function saveOpenFolders() {
    try {
      window.localStorage.setItem(OPEN_KEY, JSON.stringify([...openFolders]))
    } catch {
      // Folds back up on the next load.
    }
  }

  // ---- The menu ------------------------------------------------------------------------

  const openFolders = readOpenFolders()
  let sort = readSort()
  let sortsOpen = false
  let root = null
  let trigger = null
  let query = ''
  // Page rows that Enter / the arrow keys go through, and the highlighted one.
  let pageRows = []
  let active = -1
  let renaming = null
  let actionsFor = null
  let shownSignature = ''
  // The folder of the page on screen when the menu last drew.
  let shownFolder = ''
  let refreshTimer = null

  function editor() {
    return window.__cowartEditor || null
  }

  function holders() {
    return window.__cowartPageHolders || {}
  }

  function signature(ed) {
    const pages = ed.getPages().map((page) => `${page.id}|${page.name}|${page.index}|${folderOf(page)}`)
    // 最近改过 follows the times, and its 5 分钟前 the clock.
    const times = sort === 'recent' ? [JSON.stringify(changedAt()), Math.floor(Date.now() / 60000)] : []
    return [ed.getCurrentPageId(), ...pages, JSON.stringify(holders()), ...times].join('\n')
  }

  function pageRow(page, depth, { withPath = false, time = null } = {}) {
    const ed = editor()
    const current = page.id === ed.getCurrentPageId()
    const holder = holders()[page.id]
    const readonly = ed.getIsReadonly()
    const folder = folderOf(page)
    const name = `<span class="label" title="${kit.escapeHtml(page.name)}">${kit.escapeHtml(page.name)}</span>`
    // In a flat list the folder goes under the name, which keeps the row's width.
    const label =
      renaming === page.id
        ? `<input class="rename" value="${kit.escapeHtml(page.name)}" aria-label="页名" />`
        : withPath && folder
          ? `<span class="stack">${name}<span class="path" title="${kit.escapeHtml(folder)}">${kit.escapeHtml(folder)}</span></span>`
          : name
    return (
      `<div class="row page${current ? ' current' : ''}${actionsFor === page.id ? ' menu-open' : ''}" data-page="${kit.escapeHtml(page.id)}" style="padding-left:${6 + depth * INDENT}px">` +
      `<span class="chev"></span><span class="kind">${ICON.page}</span>${label}` +
      (time && renaming !== page.id ?`<span class="time" title="${kit.escapeHtml(new Date(time).toLocaleString())} 改过">${ago(time)}</span>` : '') +
      (holder && renaming !== page.id ? `<span class="who" title="这一页由${kit.escapeHtml(holder.name)}负责">${kit.escapeHtml(holder.name)}负责</span>` : '') +
      (readonly || renaming === page.id ? '' : `<button class="more" data-more="${kit.escapeHtml(page.id)}" title="重命名、复制、删除" aria-label="更多">${ICON.more}</button>`) +
      `</div>`
    )
  }

  function treeRows(node, depth, out) {
    for (const child of node.children) {
      if (child.page) {
        out.push(pageRow(child.page, depth))
        continue
      }
      const folder = child.folder
      const open = openFolders.has(folder.path)
      out.push(
        `<div class="row folder${open ? ' open' : ''}" data-folder="${kit.escapeHtml(folder.path)}" style="padding-left:${6 + depth * INDENT}px">` +
          `<span class="chev">${ICON.chevron}</span><span class="kind">${ICON.folder}</span>` +
          `<span class="label" title="${kit.escapeHtml(folder.path)}">${kit.escapeHtml(folder.name)}</span><span class="count">${folder.count}</span></div>`
      )
      if (open) treeRows(folder, depth + 1, out)
    }
  }

  function matches(page, words) {
    const haystack = `${folderOf(page)}/${page.name}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  }

  function render() {
    const ed = editor()
    if (!root || !ed) return
    shownSignature = signature(ed)
    shownFolder = folderOf(ed.getCurrentPage())
    const pages = ed.getPages()
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const rows = []
    let empty = ''
    if (words.length > 0 || sort === 'recent') {
      // A search, and 最近改过, are one list: each page says which folder it is in.
      const found = words.length > 0 ? pages.filter((page) => matches(page, words)) : pages
      const times = changedAt()
      if (sort === 'recent') {
        const dated = found.filter((page) => times[page.id]).sort((a, b) => times[b.id] - times[a.id])
        const undated = found.filter((page) => !times[page.id])
        for (const page of dated) rows.push(pageRow(page, 0, { withPath: true, time: times[page.id] }))
        if (dated.length > 0 && undated.length > 0) rows.push('<div class="divider">更早的页（还没有改动记录）</div>')
        for (const page of undated) rows.push(pageRow(page, 0, { withPath: true }))
      } else {
        for (const page of sort === 'name' ? [...found].sort((a, b) => byName(a.name, b.name)) : found) rows.push(pageRow(page, 0, { withPath: true }))
      }
      if (found.length === 0) empty = `没有页名或文件夹里带「${kit.escapeHtml(query.trim())}」的页。`
    } else {
      treeRows(buildTree(pages, sort), 0, rows)
    }
    const foldered = pages.some((page) => folderOf(page))
    const list = root.querySelector('.list')
    const scrollTop = list.scrollTop
    list.innerHTML =
      rows.join('') +
      (empty ? `<div class="empty">${empty}</div>` : '') +
      (!foldered && words.length === 0 ? '<div class="hint">页多了，可以在对话里让 AI 把页分进文件夹。</div>' : '')
    list.scrollTop = scrollTop
    pageRows = [...list.querySelectorAll('.row.page')]
    if (active >= pageRows.length) active = pageRows.length - 1
    if (active >= 0) pageRows[active].classList.add('active')
    root.querySelector('.footer').hidden = ed.getIsReadonly()
    if (renaming) {
      const input = list.querySelector('.rename')
      if (input && document.activeElement !== input) {
        input.focus()
        input.select()
      }
    }
    const sortButton = root.querySelector('.sort')
    sortButton.querySelector('span').textContent = SORTS.find((entry) => entry.id === sort).label
    sortButton.setAttribute('aria-expanded', String(sortsOpen))
    root.querySelector('.sorts')?.remove()
    if (sortsOpen) {
      const menu = document.createElement('div')
      menu.className = 'sorts'
      menu.innerHTML = SORTS.map((entry) => `<button data-sort="${entry.id}"><span class="tick">${entry.id === sort ? ICON.check : ''}</span>${entry.label}</button>`).join('')
      root.appendChild(menu)
    }
    if (actionsFor) showActions(actionsFor)
  }

  function place() {
    if (!root || !trigger) return
    const rect = trigger.getBoundingClientRect()
    const top = rect.bottom + 4
    root.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - root.offsetWidth - 8))}px`
    root.style.top = `${top}px`
    root.style.maxHeight = `${Math.max(160, window.innerHeight - top - 64)}px`
  }

  function open(button) {
    const ed = editor()
    if (!ed) return
    trigger = button
    query = ''
    active = -1
    renaming = null
    actionsFor = null
    sortsOpen = false
    for (const folder of ancestorsOf(folderOf(ed.getCurrentPage()))) openFolders.add(folder)
    saveOpenFolders()

    root = document.createElement('div')
    root.className = 'cowart-page-tree'
    // Clicks on rows keep the keys here (arrows, Enter, Esc) rather than on the page body.
    root.tabIndex = -1
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', '页')
    root.innerHTML =
      `<div class="top"><label class="search">${ICON.search}<input type="text" placeholder="找页：页名或文件夹" aria-label="找页" /></label>` +
      `<button class="sort" type="button" title="排序" aria-haspopup="menu">${ICON.sort}<span></span></button></div>` +
      '<div class="list" role="tree"></div>' +
      `<div class="footer"><button class="create" type="button"><span>新建页面</span>${ICON.plus}</button></div>`
    kit.stopCanvasEvents(root)
    root.addEventListener('click', onClick)
    root.addEventListener('dblclick', onDoubleClick)
    root.addEventListener('contextmenu', onContextMenu)
    root.addEventListener('keydown', onKeyDown)
    root.querySelector('.search input').addEventListener('input', (event) => {
      query = event.target.value
      active = query.trim() ? 0 : -1
      actionsFor = null
      render()
    })
    const theme = trigger.closest('.tl-container')
    if (theme) {
      const computed = getComputedStyle(theme)
      for (const name of THEME_VARS) root.style.setProperty(name, computed.getPropertyValue(name))
      root.style.fontFamily = computed.fontFamily
    }
    document.body.appendChild(root)
    trigger.setAttribute('data-cowart-open', 'true')
    render()
    place()
    root.querySelector('.search input').focus()
    // 最近改过 reads from the top; the trees open where the page on screen is.
    const current = sort === 'recent' ? null : root.querySelector('.row.current')
    if (current) current.scrollIntoView({ block: 'nearest' })
    refreshTimer = setInterval(refresh, REFRESH_MS)
  }

  function close() {
    if (!root) return
    clearInterval(refreshTimer)
    refreshTimer = null
    root.remove()
    root = null
    if (trigger) trigger.removeAttribute('data-cowart-open')
    trigger = null
    renaming = null
    actionsFor = null
  }

  // Pages renamed, added, sorted into folders elsewhere (another pane, a session) show up; when
  // the page on screen moved to another folder, that folder unfolds.
  function refresh() {
    const ed = editor()
    if (!root || !ed || !document.contains(root)) return close()
    if (renaming) return
    if (signature(ed) !== shownSignature) {
      const folder = folderOf(ed.getCurrentPage())
      if (folder !== shownFolder) {
        for (const path of ancestorsOf(folder)) openFolders.add(path)
        saveOpenFolders()
      }
      render()
    }
    place()
  }

  // The menu stays open: the user looks through pages one after another (2026-10-22: closing it
  // on every click made that a chore). A click on the canvas, Esc or the button closes it.
  function goTo(pageId) {
    const ed = editor()
    if (!ed || !ed.getPage(pageId)) return
    if (ed.getCurrentPageId() !== pageId) ed.setCurrentPage(pageId)
    render()
    active = pageRows.findIndex((row) => row.dataset.page === pageId)
    for (const row of pageRows) row.classList.toggle('active', row === pageRows[active])
  }

  function toggleFolder(path) {
    if (openFolders.has(path)) openFolders.delete(path)
    else openFolders.add(path)
    saveOpenFolders()
    render()
  }

  // ---- Page actions (tldraw's page menu had them) --------------------------------------

  function showActions(pageId) {
    const ed = editor()
    const row = root && root.querySelector(`.row.page[data-page="${CSS.escape(pageId)}"]`)
    root && root.querySelector('.actions')?.remove()
    if (!ed || !row) {
      actionsFor = null
      return
    }
    actionsFor = pageId
    row.classList.add('menu-open')
    const menu = document.createElement('div')
    menu.className = 'actions'
    menu.innerHTML =
      '<button data-action="rename">重命名</button><button data-action="duplicate">复制一份</button>' +
      (ed.getPages().length > 1 ? '<button class="danger" data-action="delete">删除</button>' : '')
    root.appendChild(menu)
    const rootRect = root.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const below = rowRect.bottom - rootRect.top
    const fitsBelow = below + menu.offsetHeight <= rootRect.height
    menu.style.right = '8px'
    menu.style.top = `${fitsBelow ? below : Math.max(4, rowRect.top - rootRect.top - menu.offsetHeight)}px`
  }

  function hideActions() {
    if (!actionsFor) return
    actionsFor = null
    root?.querySelector('.actions')?.remove()
    root?.querySelector('.row.menu-open')?.classList.remove('menu-open')
  }

  function randomPageId() {
    return `page:${kit.randomKey()}${Date.now().toString(36)}`
  }

  function runAction(action, pageId) {
    const ed = editor()
    const page = ed && ed.getPage(pageId)
    hideActions()
    if (!page) return
    if (action === 'rename') {
      startRenaming(pageId)
    } else if (action === 'duplicate') {
      // tldraw names the copy «… Copy» and leaves its folder behind.
      const copyId = randomPageId()
      ed.markHistoryStoppingPoint('creating page')
      ed.duplicatePage(pageId, copyId)
      const copy = ed.getPage(copyId)
      if (copy) ed.updatePage({ id: copyId, name: `${page.name} 副本`, meta: { ...copy.meta, ...(folderOf(page) ? { [FOLDER_KEY]: folderOf(page) } : {}) } })
      close()
    } else if (action === 'delete') {
      if (ed.getPages().length <= 1) return
      ed.markHistoryStoppingPoint('deleting page')
      ed.deletePage(pageId)
      render()
    }
  }

  function startRenaming(pageId) {
    if (editor()?.getIsReadonly()) return
    renaming = pageId
    render()
  }

  function finishRenaming(commit) {
    const ed = editor()
    const input = root && root.querySelector('.rename')
    const pageId = renaming
    renaming = null
    if (commit && ed && input && pageId && ed.getPage(pageId)) {
      const name = input.value.trim()
      if (name && name !== ed.getPage(pageId).name) ed.renamePage(pageId, name)
    }
    if (root) render()
  }

  function createPage() {
    const ed = editor()
    if (!ed || ed.getIsReadonly()) return
    const id = randomPageId()
    ed.run(() => {
      ed.markHistoryStoppingPoint('creating page')
      ed.createPage({ name: '新页面', id })
      ed.setCurrentPage(id)
    })
    query = ''
    if (root) root.querySelector('.search input').value = ''
    startRenaming(id)
    root?.querySelector('.row.current')?.scrollIntoView({ block: 'nearest' })
  }

  // ---- Events --------------------------------------------------------------------------

  function onClick(event) {
    const target = event.target
    // A click anywhere else in the menu keeps the name being typed, then does what it does.
    if (renaming && !target.closest('.rename')) finishRenaming(true)
    const action = target.closest('.actions button')
    if (action) return runAction(action.dataset.action, actionsFor)
    const choice = target.closest('.sorts button')
    if (choice) return setSort(choice.dataset.sort)
    if (target.closest('.sort')) {
      sortsOpen = !sortsOpen
      return render()
    }
    if (sortsOpen) {
      sortsOpen = false
      render()
    }
    if (target.closest('.create')) return createPage()
    const more = target.closest('.more')
    if (more) {
      if (actionsFor === more.dataset.more) hideActions()
      else showActions(more.dataset.more)
      return
    }
    hideActions()
    if (target.closest('.rename')) return
    const folder = target.closest('.row.folder')
    if (folder) return toggleFolder(folder.dataset.folder)
    const page = target.closest('.row.page')
    if (page) goTo(page.dataset.page)
  }

  function onDoubleClick(event) {
    const page = event.target.closest('.row.page')
    if (page && !event.target.closest('.more')) startRenaming(page.dataset.page)
  }

  function onContextMenu(event) {
    event.preventDefault()
    const page = event.target.closest('.row.page')
    if (page && !editor()?.getIsReadonly() && !renaming) showActions(page.dataset.page)
  }

  function moveActive(step) {
    if (pageRows.length === 0) return
    pageRows[active]?.classList.remove('active')
    active = (active + step + pageRows.length) % pageRows.length
    pageRows[active].classList.add('active')
    pageRows[active].scrollIntoView({ block: 'nearest' })
  }

  function onKeyDown(event) {
    if (event.target.classList?.contains('rename')) {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        finishRenaming(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finishRenaming(false)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (actionsFor) return hideActions()
      if (sortsOpen) {
        sortsOpen = false
        return render()
      }
      if (query) {
        query = ''
        root.querySelector('.search input').value = ''
        active = -1
        return render()
      }
      const button = trigger
      close()
      button?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      return moveActive(event.key === 'ArrowDown' ? 1 : -1)
    }
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
      const row = pageRows[active] || (query.trim() ? pageRows[0] : null)
      if (row) {
        event.preventDefault()
        goTo(row.dataset.page)
      }
    }
  }

  // The page menu button opens this menu: tldraw's popover never hears the click (Radix opens
  // it on click, and the click stops here before it reaches React's root).
  window.addEventListener(
    'click',
    (event) => {
      const button = event.target instanceof Element ? event.target.closest(TRIGGER) : null
      if (!button || !editor()) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (root) close()
      else open(button)
    },
    true
  )

  window.addEventListener(
    'pointerdown',
    (event) => {
      if (!root) return
      const target = event.target instanceof Element ? event.target : null
      if (target && (root.contains(target) || target.closest(TRIGGER))) return
      if (renaming) finishRenaming(true)
      close()
    },
    true
  )

  window.addEventListener('resize', () => place())
  window.addEventListener('cowart:page-holders', () => {
    if (root && !renaming) render()
  })
})()
