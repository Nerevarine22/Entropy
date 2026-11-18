(async () => {
  'use strict';
  const M = window.EntropyModel;
  const $ = id => document.getElementById(id);
  const source = document.currentScript.dataset.source;
  let data;
  try {
    let payload = window.EntropySeed;
    if (source) {
      $('page-leaderboard').hidden = true;
      $('load-status').hidden = false;
      $('load-status').textContent = 'Loading leaderboard…';
      const response = await fetch(source, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('Leaderboard request failed.');
      payload = await response.json();
    }
    data = M.validateDataset(payload);
    $('load-status').hidden = true;
  } catch {
    $('page-leaderboard').hidden = true;
    $('load-status').hidden = false;
    $('load-status').textContent = 'Leaderboard is temporarily unavailable. Refresh the page to try again.';
    return;
  }
  let state = M.initialState();
  if (!source) {
    try { const saved = JSON.parse(localStorage.getItem('entropy-workbench-v1') || 'null'); if (saved?.state) state = M.validateState(saved.state); } catch (_) {}
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const format = value => value === null ? '—' : new Intl.NumberFormat('en-US').format(value);
  const compact = value => value === null ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const safeImage = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'pbs.twimg.com' && !u.port && !u.username && !u.password ? u.href : ''; } catch (_) { return ''; } };
  const avatar = person => { const url = safeImage(person.avatarUrl), initial = esc((person.displayName || person.handle || '?').trim().charAt(0).toUpperCase()); return url ? `<img class="avatar" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="avatar avatar-fallback" aria-hidden="true">${initial}</span>`; };
  const add = (posts, field) => posts.every(post => typeof post.metrics[field] === 'number') ? posts.reduce((sum, post) => sum + post.metrics[field], 0) : null;
  const rows = data.authors.filter(a => !state.bans[a.id]).map(author => {
    const posts = data.posts.filter(post => post.authorId === author.id && post.isReply !== true && !state.postExclusions[post.id] && !state.periodDecisions[post.date.slice(0, 7) + '|' + author.id]);
    const views = add(posts, 'impressions'), likes = add(posts, 'likes'), reposts = add(posts, 'reposts'), quotes = add(posts, 'quotes');
    const engagement = views > 0 && [likes, reposts, quotes].every(x => x !== null) ? (likes + reposts + quotes) / views * 100 : null;
    return { author, posts, views, likes, engagement };
  }).filter(row => row.posts.length)
    .sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || a.author.handle.localeCompare(b.author.handle))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const totals = rows.flatMap(row => row.posts);
  $('creator-total').textContent = format(rows.length);
  $('post-total').textContent = format(totals.length);
  $('view-total').textContent = compact(add(totals, 'impressions'));
  if (data.meta.asOf && !Number.isNaN(Date.parse(data.meta.asOf))) $('updated').textContent = 'UPDATED ' + new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(data.meta.asOf)).toUpperCase();

  const PAGE_SIZE = 20;
  let boardPage = 1;

  function renderPagination(totalPages) {
    const pagination = $('board-pagination');
    pagination.hidden = totalPages <= 1;
    if (pagination.hidden) {
      pagination.replaceChildren();
      return;
    }

    const pages = [1];
    const first = Math.max(2, Math.min(boardPage - 1, totalPages - 4));
    const last = Math.min(totalPages - 1, Math.max(5, boardPage + 1));
    for (let page = first; page <= last; page++) pages.push(page);
    pages.push(totalPages);

    const numberedButtons = pages.map((page, index) => {
      const gap = index > 0 && page - pages[index - 1] > 1 ? '<span aria-hidden="true">…</span>' : '';
      const current = page === boardPage ? ' aria-current="page"' : '';
      return `${gap}<button type="button" data-page-number="${page}" aria-label="Page ${page}"${current}>${page}</button>`;
    }).join('');

    pagination.innerHTML = `
      <button type="button" data-page-number="${boardPage - 1}" aria-label="Previous page" ${boardPage === 1 ? 'disabled' : ''}>‹</button>
      ${numberedButtons}
      <button type="button" data-page-number="${boardPage + 1}" aria-label="Next page" ${boardPage === totalPages ? 'disabled' : ''}>›</button>`;
  }

  function buildTable() {
    const term = $('search').value.trim().replace(/^@/, '').toLowerCase();
    const matches = rows.filter(row => !term || row.author.handle.toLowerCase().includes(term) || (row.author.displayName || '').toLowerCase().includes(term));
    const totalPages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    boardPage = Math.min(Math.max(1, boardPage), totalPages);
    const start = (boardPage - 1) * PAGE_SIZE;
    const visible = matches.slice(start, start + PAGE_SIZE);
    $('leaderboard-body').innerHTML = visible.map(row => {
      const count = row.author.twitterScore?.smartFollowers;
      const smartFollowers = Number.isSafeInteger(count) && count >= 0 ? count : null;
      return `<tr tabindex="0" role="button" data-creator="${esc(row.author.id)}" aria-label="View ${esc(row.author.handle)} profile">
        <td><span class="rank ${row.rank <= 3 ? 'top' : ''}">${String(row.rank).padStart(2, '0')}</span></td>
        <td><div class="creator">${avatar(row.author)}<div><span class="creator-name">${esc(row.author.displayName || row.author.handle)}</span><span class="creator-handle">@${esc(row.author.handle)}</span></div></div></td>
        <td class="num">${format(row.posts.length)}</td>
        <td class="num primary">${format(row.views)}</td>
        <td class="num">${format(row.likes)}</td>
        <td class="num">${row.engagement === null ? '—' : row.engagement.toFixed(2) + '%'}</td>
        <td class="num" data-metric="smart-followers">${format(smartFollowers)}</td>
        <td class="row-arrow">↗</td>
      </tr>`;
    }).join('');
    $('empty').hidden = visible.length > 0;
    $('board-count').textContent = matches.length
      ? `${format(start + 1)}–${format(start + visible.length)} of ${format(matches.length)} creators`
      : '';
    renderPagination(totalPages);
  }
  // Binary treemap: the tile areas reflect the observed share of views.
  function treemap(items, x, y, width, height) {
    if (!items.length) return;
    if (items.length === 1) {
      const { row, weight } = items[0], tile = document.createElement('button'), image = safeImage(row.author.avatarUrl);
      tile.type = 'button'; tile.className = 'map-tile' + (width < 12 || height < 18 ? ' small' : '');
      tile.dataset.creator = row.author.id;
      tile.setAttribute('aria-label', `${row.author.displayName || row.author.handle}, ${format(row.views)} views`);
      Object.assign(tile.style, { left: x + '%', top: y + '%', width: width + '%', height: height + '%' });
      const largerImage = image.replace(/_normal(\.[a-z]+)(?=\?|$)/i, '_400x400$1');
      tile.innerHTML = (image ? `<img src="${esc(largerImage)}" data-fallback="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '') + `<span class="tile-content"><span class="tile-name">${esc(row.author.displayName || row.author.handle)}</span><span class="tile-views">${compact(row.views)}</span></span>`;
      $('influence-map').append(tile); return;
    }
    const total = items.reduce((sum, item) => sum + item.weight, 0); let sum = 0, split = 0;
    while (split < items.length - 1 && sum + items[split].weight <= total / 2) { sum += items[split].weight; split++; }
    if (!split) { split = 1; sum = items[0].weight; }
    const ratio = sum / total, wide = width * $('influence-map').clientWidth >= height * $('influence-map').clientHeight;
    if (wide) { treemap(items.slice(0, split), x, y, width * ratio, height); treemap(items.slice(split), x + width * ratio, y, width * (1 - ratio), height); }
    else { treemap(items.slice(0, split), x, y, width, height * ratio); treemap(items.slice(split), x, y + height * ratio, width, height * (1 - ratio)); }
  }
  function buildMap() {
    const top = rows.filter(row => row.views !== null && row.views > 0).slice(0, 20);
    $('influence-map').replaceChildren();
    if (top.length) treemap(top.map(row => ({ row, weight: row.views })), 0, 0, 100, 100);
    else $('influence-map').textContent = 'No view data available yet.';
    $('map-count').textContent = top.length ? `Top ${top.length} by views` : '';
  }

  function renderPost(post, index) {
    const text = (post.body || post.summary || 'Post text unavailable.').replace(/\r\n/g, '\n').trim();
    const firstLines = text.split('\n', 7).slice(0, 6).join('\n');
    const characters = Array.from(firstLines);
    const truncated = firstLines !== text || characters.length > 300;
    let preview = characters.slice(0, 300).join('');
    if (characters.length > 300) {
      const boundary = preview.search(/\s+\S*$/u);
      if (boundary > 240) preview = preview.slice(0, boundary);
    }
    const fullId = `profile-post-text-${index}`;
    const copy = truncated
      ? `<p class="post-preview">${esc(preview.trimEnd())}…</p>
         <p id="${fullId}" class="post-full" hidden>${esc(text)}</p>
         <button type="button" class="post-toggle" aria-controls="${fullId}" aria-expanded="false">Show more</button>`
      : `<p>${esc(text)}</p>`;
    return `<article class="profile-post">
      ${copy}
      <div class="profile-post-meta">
        <a href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">VIEW POST ↗</a>
        <time datetime="${esc(post.date)}">${esc(post.date)}</time>
      </div>
    </article>`;
  }

  function openCreator(id) {
    const row = rows.find(item => item.author.id === id); if (!row) return;
    const name = row.author.displayName || row.author.handle;
    const posts = row.posts.slice().sort((a, b) => (b.publishedAt || b.date).localeCompare(a.publishedAt || a.date));
    $('dialog-content').innerHTML = `
      <div class="profile-hero">
        ${avatar(row.author)}
        <div><h2 id="dialog-name">${esc(name)}</h2><a href="https://x.com/${encodeURIComponent(row.author.handle)}" target="_blank" rel="noopener noreferrer">@${esc(row.author.handle)} ↗</a></div>
      </div>
      <div class="profile-stats">
        <div><span>INDEXED POSTS</span><strong>${format(row.posts.length)}</strong></div>
        <div><span>TOTAL VIEWS</span><strong>${format(row.views)}</strong></div>
        <div><span>TOTAL LIKES</span><strong>${format(row.likes)}</strong></div>
      </div>
      <h3 class="profile-posts-title">Indexed posts</h3>
      <div class="profile-posts">${posts.map(renderPost).join('')}</div>`;
    const dialog = $('creator-dialog');
    dialog.showModal();
    dialog.scrollTop = 0;
  }
  function showPage() {
    const key = ['leaderboard', 'methodology', 'about'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'leaderboard';
    document.querySelectorAll('.page').forEach(el => { el.hidden = el.id !== 'page-' + key; });
    document.querySelectorAll('[data-page]').forEach(el => { el.classList.toggle('active', el.dataset.page === key); if (el.dataset.page === key) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
    if (key === 'leaderboard') buildMap();
  }
  document.addEventListener('click', event => { const target = event.target.closest('[data-creator]'); if (target) openCreator(target.dataset.creator); });
  document.addEventListener('keydown', event => { const target = event.target.closest('tr[data-creator]'); if (target && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openCreator(target.dataset.creator); } if (event.key === '/' && !event.target.matches('input,textarea') && location.hash !== '#about' && location.hash !== '#methodology') { event.preventDefault(); $('search').focus(); } });
  document.addEventListener('error', event => { if (event.target.matches?.('img.avatar')) { const replacement = document.createElement('span'); replacement.className = 'avatar avatar-fallback'; replacement.textContent = '?'; event.target.replaceWith(replacement); } else if (event.target.closest?.('.map-tile') && event.target.tagName === 'IMG') { const fallback = event.target.dataset.fallback; if (fallback && event.target.src !== fallback) { delete event.target.dataset.fallback; event.target.src = fallback; } else event.target.remove(); } }, true);
  $('close-dialog').addEventListener('click', () => $('creator-dialog').close());
  $('creator-dialog').addEventListener('click', event => { if (event.target === $('creator-dialog')) $('creator-dialog').close(); });
  $('dialog-content').addEventListener('click', event => {
    const button = event.target.closest('.post-toggle');
    if (!button) return;

    const full = $(button.getAttribute('aria-controls'));
    const preview = button.closest('.profile-post').querySelector('.post-preview');
    const expand = full.hidden;
    full.hidden = !expand;
    preview.hidden = expand;
    button.setAttribute('aria-expanded', String(expand));
    button.textContent = expand ? 'Show less' : 'Show more';
  });
  $('search').addEventListener('input', () => {
    boardPage = 1;
    buildTable();
  });
  $('board-pagination').addEventListener('click', event => {
    const button = event.target.closest('button[data-page-number]');
    if (!button || button.disabled) return;
    const page = Number(button.dataset.pageNumber);
    if (page === boardPage) return;
    boardPage = page;
    buildTable();
    const heading = $('board-heading');
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'start', behavior: 'instant' });
  });
  window.addEventListener('hashchange', showPage);
  window.addEventListener('resize', () => { if (!$('page-leaderboard').hidden) buildMap(); });
  buildTable(); showPage();
})();
