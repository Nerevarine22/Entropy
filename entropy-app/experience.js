(() => {
  'use strict';
  const M = window.EntropyModel;
  const data = M.validateDataset(window.EntropySeed);
  let state = M.initialState();
  try { const saved = JSON.parse(localStorage.getItem('entropy-workbench-v1') || 'null'); if (saved?.state) state = M.validateState(saved.state); } catch (_) {}
  const $ = id => document.getElementById(id);
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
  }).filter(row => row.posts.length).sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || a.author.handle.localeCompare(b.author.handle));
  const totals = rows.flatMap(row => row.posts);
  $('creator-total').textContent = format(rows.length);
  $('post-total').textContent = format(totals.length);
  $('view-total').textContent = compact(add(totals, 'impressions'));
  if (data.meta.asOf && !Number.isNaN(Date.parse(data.meta.asOf))) $('updated').textContent = 'UPDATED ' + new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(data.meta.asOf)).toUpperCase();

  function buildTable() {
    const term = $('search').value.trim().replace(/^@/, '').toLowerCase();
    const visible = rows.map((row, index) => ({ ...row, rank: index + 1 })).filter(row => !term || row.author.handle.toLowerCase().includes(term) || (row.author.displayName || '').toLowerCase().includes(term));
    $('leaderboard-body').innerHTML = visible.map(row => `<tr tabindex="0" role="button" data-creator="${esc(row.author.id)}" aria-label="View ${esc(row.author.handle)} profile"><td><span class="rank ${row.rank <= 3 ? 'top' : ''}">${String(row.rank).padStart(2, '0')}</span></td><td><div class="creator">${avatar(row.author)}<div><span class="creator-name">${esc(row.author.displayName || row.author.handle)}</span><span class="creator-handle">@${esc(row.author.handle)}</span></div></div></td><td class="num">${format(row.posts.length)}</td><td class="num primary">${format(row.views)}</td><td class="num">${format(row.likes)}</td><td class="num">${row.engagement === null ? '—' : row.engagement.toFixed(2) + '%'}</td><td class="row-arrow">↗</td></tr>`).join('');
    $('empty').hidden = visible.length > 0;
    $('board-count').textContent = term && visible.length ? `${visible.length} of ${rows.length} creators` : '';
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
  function openCreator(id) {
    const row = rows.find(item => item.author.id === id); if (!row) return;
    const name = row.author.displayName || row.author.handle;
    $('dialog-content').innerHTML = `<div class="profile-hero">${avatar(row.author)}<div><h2 id="dialog-name">${esc(name)}</h2><a href="https://x.com/${encodeURIComponent(row.author.handle)}" target="_blank" rel="noopener noreferrer">@${esc(row.author.handle)} ↗</a></div></div><div class="profile-stats"><div><span>INDEXED POSTS</span><strong>${format(row.posts.length)}</strong></div><div><span>TOTAL VIEWS</span><strong>${format(row.views)}</strong></div><div><span>TOTAL LIKES</span><strong>${format(row.likes)}</strong></div></div><h3 class="profile-posts-title">Indexed posts</h3>${row.posts.slice().sort((a,b) => String(b.publishedAt || b.date).localeCompare(String(a.publishedAt || a.date))).map(post => `<article class="profile-post"><p>${esc(post.body || post.summary || 'Post text unavailable.')}</p><a href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">VIEW POST ↗</a><time>${esc(post.date)}</time></article>`).join('')}`;
    $('creator-dialog').showModal();
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
  $('search').addEventListener('input', buildTable);
  window.addEventListener('hashchange', showPage);
  window.addEventListener('resize', () => { if (!$('page-leaderboard').hidden) buildMap(); });
  buildTable(); showPage();
})();
