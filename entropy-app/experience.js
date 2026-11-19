(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const admin = /^\/admin\/?$/.test(location.pathname);
  const source = admin ? '/api/admin' : document.currentScript.dataset.source;
  async function getData(params, signal, action) {
    const url = new URL(source, location.origin);
    url.search = new URLSearchParams(params);
    const timeout = AbortSignal.timeout(12000);
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) } : {}) });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(admin && typeof data.error === 'string' ? data.error : 'Leaderboard request failed.');
      error.status = response.status;
      throw error;
    }
    return data;
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const format = value => value === null ? '—' : new Intl.NumberFormat('en-US').format(value);
  const compact = value => value === null ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const safeImage = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'pbs.twimg.com' && !u.port && !u.username && !u.password ? u.href : ''; } catch (_) { return ''; } };
  const avatar = person => { const url = safeImage(person.avatarUrl), initial = esc((person.displayName || person.handle || '?').trim().charAt(0).toUpperCase()); return url ? `<img class="avatar" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="avatar avatar-fallback" aria-hidden="true">${initial}</span>`; };
  let rows = [], leaders = [];
  let boardPage = 1;
  let boardRequest, searchTimer;
  let loadedBoard = false;
  let adminSignedIn = false;
  const earlyBadge = '<span class="early-badge" title="Posted about Entropy before October 16, 2026 (UTC)">Early</span>';
  const reviewDate = value => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value)) : '';

  function reviewBadge(review) {
    if (review?.status === 'reviewed') {
      return `<span class="review-badge reviewed">Reviewed · ${esc(reviewDate(review.reviewedAt))}</span>`;
    }
    if (review?.status === 'needs-review') return '<span class="review-badge needs-review">Needs review</span>';
    return '<span class="review-badge">Not reviewed</span>';
  }

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

  function buildTable(data) {
    const { rows: visible, page, totalPages, offset, total } = data;
    boardPage = page;
    rows = visible;
    $('leaderboard-body').innerHTML = visible.map(row => {
      const count = row.author.twitterScore?.smartFollowers;
      const smartFollowers = Number.isSafeInteger(count) && count >= 0 ? count : null;
      const rank = row.rank === null ? '<span class="rank">—</span>' : row.rank <= 3
        ? `<span class="rank rank-podium rank-podium-${row.rank}">${row.rank}</span>`
        : `<span class="rank">${String(row.rank).padStart(2, '0')}</span>`;
      return `<tr tabindex="0" role="button" data-creator="${esc(row.author.id)}" aria-label="View ${esc(row.author.handle)} profile${row.early ? ', Early creator' : ''}">
        <td>${rank}</td>
        <td><div class="creator">${avatar(row.author)}<div><div class="creator-name-line"><span class="creator-name">${esc(row.author.displayName || row.author.handle)}</span>${row.early ? earlyBadge : ''}${!admin && row.reviewedAt ? reviewBadge({ status: 'reviewed', reviewedAt: row.reviewedAt }) : ''}</div><span class="creator-handle">@${esc(row.author.handle)}</span></div></div></td>
        <td class="num">${format(row.postCount)}${admin && row.totalPosts > row.postCount ? `<small class="excluded-count">${format(row.totalPosts - row.postCount)} excluded</small>` : ''}</td>
        <td class="num primary">${format(row.views)}</td>
        <td class="num">${format(row.likes)}</td>
        <td class="num">${row.engagement === null ? '—' : row.engagement.toFixed(2) + '%'}</td>
        <td class="num" data-metric="smart-followers">${format(smartFollowers)}</td>
        ${admin ? `<td class="review-column">${reviewBadge(row.review)}${row.review.snapshotId ? `<small class="review-snapshot" title="${esc(row.review.snapshotId)}">${esc(row.review.snapshotId.slice(0, 8))} · ${esc(reviewDate(row.review.datasetAsOf || row.review.reviewedAt))}</small>` : ''}</td>` : ''}
        <td class="row-arrow">↗</td>
      </tr>`;
    }).join('');
    $('empty').hidden = visible.length > 0;
    $('board-count').textContent = total
      ? `${format(offset + 1)}–${format(offset + visible.length)} of ${format(total)} creators`
      : '';
    renderPagination(totalPages);
  }

  async function loadBoard(page, scrollToTable = false) {
    boardRequest?.abort();
    const request = new AbortController();
    boardRequest = request;
    $('leaderboard-body').setAttribute('aria-busy', 'true');
    if (!loadedBoard) $('load-status').textContent = 'Loading leaderboard…';
    const q = $('search').value.trim();
    try {
      const status = admin ? $('review-filter').value : '';
      const data = await getData({ view: 'ranking', page, ...(q ? { q } : {}), ...(status ? { status } : {}) }, request.signal);
      if (request.signal.aborted) return;
      const mapChanged = !loadedBoard || JSON.stringify(leaders) !== JSON.stringify(data.leaders);
      leaders = data.leaders;
      $('creator-total').textContent = format(data.totals.creators);
      $('post-total').textContent = format(data.totals.posts);
      $('view-total').textContent = compact(data.totals.views);
      if (data.asOf) $('updated').textContent = 'UPDATED ' + new Intl.DateTimeFormat('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
      }).format(new Date(data.asOf)).toUpperCase();
      buildTable(data);
      loadedBoard = true;
      $('load-status').hidden = true;
      if (mapChanged && !$('page-leaderboard').hidden) buildMap();
      if (scrollToTable && !$('page-leaderboard').hidden) {
        const heading = $('board-heading');
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
    } catch (error) {
      if (request.signal.aborted) return;
      if (admin && error.status === 401) { showAdminSignIn('Your session has expired.'); return; }
      const status = loadedBoard ? $('board-count') : $('load-status');
      status.hidden = false;
      status.textContent = 'Could not load the leaderboard. Please try again.';
    } finally {
      if (boardRequest === request) $('leaderboard-body').setAttribute('aria-busy', 'false');
    }
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
    const top = leaders;
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

  let profileRequest;
  let profileId;
  let nextPostPage = 1;
  let profileSnapshot;
  let moderationBusy = false;

  function renderModerationPost(post) {
    const excluded = post.exclusion || post.blockedBy;
    const reason = post.exclusion?.reason;
    return `<article class="profile-post${excluded ? ' moderation-excluded' : ''}">
      <div class="moderation-post-head"><span class="review-badge ${excluded ? 'needs-review' : 'reviewed'}">${excluded ? 'Excluded' : 'Included'}</span><time datetime="${esc(post.date)}">${esc(post.date)}</time></div>
      <p>${esc(post.body || 'Post text unavailable.')}</p>
      <div class="profile-post-meta"><a href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">VIEW POST ↗</a><span>${format(post.views)} views</span><span>${format(post.likes)} likes</span></div>
      ${reason ? `<p class="moderation-reason"><strong>Reason</strong> ${esc(reason)}</p>` : ''}
      ${post.blockedBy ? `<p class="moderation-reason">${esc(post.blockedBy)} also applies.</p>` : ''}
      ${post.exclusion
        ? `<form class="moderation-form" data-action="restore" data-post="${esc(post.id)}"><button class="admin-button" type="submit">Restore post</button></form>`
        : `<details class="moderation-form"><summary>Exclude post</summary><form data-action="exclude" data-post="${esc(post.id)}"><label>Reason<textarea name="reason" rows="2" minlength="3" maxlength="1000" required></textarea></label><button class="admin-button admin-button-danger" type="submit">Exclude from leaderboard</button></form></details>`}
    </article>`;
  }

  function renderReviewDetails(result) {
    const review = result.review;
    $('profile-counted-posts').textContent = format(result.totals.posts);
    $('profile-views').textContent = format(result.totals.views);
    $('profile-likes').textContent = format(result.totals.likes);
    $('moderation-review-status').innerHTML = `${reviewBadge(review)}
      <span title="${esc(result.snapshotId)}">Current snapshot ${esc(result.snapshotId.slice(0, 8))}${result.datasetAsOf ? ` · ${esc(reviewDate(result.datasetAsOf))}` : ''}</span>
      ${review.snapshotId ? `<span title="${esc(review.snapshotId)}">Last reviewed snapshot ${esc(review.snapshotId.slice(0, 8))} · ${esc(reviewDate(review.reviewedAt))}</span>` : ''}`;
    $('mark-reviewed').disabled = review.status === 'reviewed';
    const history = $('moderation-history');
    history.hidden = !result.history.length;
    const actionLabels = { exclude: 'Post excluded', restore: 'Post restored', review: 'Creator reviewed' };
    $('moderation-events').innerHTML = result.history.map(event => `<li>
      <strong>${esc(actionLabels[event.action])}</strong> · ${esc(reviewDate(event.at))} · ${esc(event.actorId)}
      <span title="${esc(event.snapshotId)}"> · ${esc(event.snapshotId.slice(0, 8))}</span>
      ${event.postId ? ` · <a href="https://x.com/i/web/status/${esc(event.postId)}" target="_blank" rel="noopener noreferrer">Post ↗</a>` : ''}
      ${event.reason ? `<p>${esc(event.reason)}</p>` : ''}</li>`).join('');
  }

  async function loadPosts(page = nextPostPage) {
    if (profileRequest || !profileId) return;
    const request = new AbortController();
    profileRequest = request;
    const status = $('profile-post-status');
    const more = $('profile-post-more');
    status.textContent = 'Loading posts…';
    more.hidden = true;
    try {
      const result = await getData({ view: 'profile', creator: profileId, page }, request.signal);
      if (request.signal.aborted) return;
      const container = $('profile-posts');
      if (admin) {
        if (profileSnapshot && result.snapshotId !== profileSnapshot) {
          profileSnapshot = null;
          $('mark-reviewed').disabled = true;
          status.textContent = 'This creator’s posts changed. Reopen the profile to review the current snapshot.';
          return;
        }
        profileSnapshot = result.snapshotId;
        const markup = `<div class="profile-posts" data-post-page="${result.page}">${result.posts.map(renderModerationPost).join('')}</div>`;
        const existing = container.querySelector(`[data-post-page="${result.page}"]`);
        if (existing) existing.outerHTML = markup;
        else container.insertAdjacentHTML('beforeend', markup);
        renderReviewDetails(result);
      } else {
        container.insertAdjacentHTML('beforeend', result.posts.map((post, index) => renderPost(post, result.offset + index)).join(''));
      }
      status.textContent = page === 1 && result.posts.length === 0 ? 'No indexed posts available.' : '';
      nextPostPage = Math.max(nextPostPage, result.page + 1);
      more.textContent = 'Load more posts';
      more.hidden = nextPostPage > result.totalPages;
    } catch (error) {
      if (request.signal.aborted) return;
      if (admin && error.status === 401) { showAdminSignIn('Your session has expired.'); return; }
      status.textContent = 'Could not load posts.';
      more.textContent = 'Try again';
      more.hidden = false;
    } finally {
      if (profileRequest === request) profileRequest = null;
    }
  }

  function openCreator(id) {
    const dialog = $('creator-dialog');
    if (dialog.open) return;
    const row = [...rows, ...leaders].find(item => item.author.id === id);
    if (!row) return;
    const name = row.author.displayName || row.author.handle;
    $('dialog-content').innerHTML = `
      <div class="profile-hero">
        ${avatar(row.author)}
        <div><div class="creator-name-line"><h2 id="dialog-name">${esc(name)}</h2>${row.early ? earlyBadge : ''}</div><a href="https://x.com/${encodeURIComponent(row.author.handle)}" target="_blank" rel="noopener noreferrer">@${esc(row.author.handle)} ↗</a></div>
      </div>
      <div class="profile-stats">
        <div><span>${admin ? 'COUNTED POSTS' : 'INDEXED POSTS'}</span><strong id="profile-counted-posts">${format(row.postCount)}</strong></div>
        <div><span>TOTAL VIEWS</span><strong id="profile-views">${format(row.views)}</strong></div>
        <div><span>TOTAL LIKES</span><strong id="profile-likes">${format(row.likes)}</strong></div>
      </div>
      ${admin ? `<div class="moderation-review"><div id="moderation-review-status"></div>
        <form data-action="review"><button id="mark-reviewed" class="admin-button admin-button-primary" type="submit" disabled>Mark reviewed</button></form>
        <p id="moderation-feedback" role="status"></p></div>
        <details id="moderation-history" class="moderation-history" hidden><summary>Moderation history</summary><ul id="moderation-events"></ul></details>` : ''}
      <h3 class="profile-posts-title">Indexed posts</h3>
      <div id="profile-posts" class="profile-posts"></div>
      <p id="profile-post-status" class="board-footer" role="status"></p>
      <button id="profile-post-more" class="post-toggle" type="button" hidden>Load more posts</button>`;
    profileId = id;
    profileSnapshot = null;
    nextPostPage = 1;
    dialog.showModal();
    dialog.scrollTop = 0;
    loadPosts();
  }
  function showPage() {
    const key = admin ? (adminSignedIn ? 'leaderboard' : '')
      : ['leaderboard', 'methodology', 'about'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'leaderboard';
    document.querySelectorAll('.page').forEach(el => { el.hidden = el.id !== 'page-' + key; });
    document.querySelectorAll('[data-page]').forEach(el => { el.classList.toggle('active', el.dataset.page === key); if (el.dataset.page === key) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
    $('load-status').hidden = key !== 'leaderboard' || loadedBoard;
    if (key === 'leaderboard' && loadedBoard) buildMap();
  }
  document.addEventListener('click', event => { const target = event.target.closest('[data-creator]'); if (target) openCreator(target.dataset.creator); });
  document.addEventListener('keydown', event => { const target = event.target.closest('tr[data-creator]'); if (target && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openCreator(target.dataset.creator); } if (event.key === '/' && !event.target.matches('input,textarea') && location.hash !== '#about' && location.hash !== '#methodology') { event.preventDefault(); $('search').focus(); } });
  document.addEventListener('error', event => { if (event.target.matches?.('img.avatar')) { const replacement = document.createElement('span'); replacement.className = 'avatar avatar-fallback'; replacement.textContent = '?'; event.target.replaceWith(replacement); } else if (event.target.closest?.('.map-tile') && event.target.tagName === 'IMG') { const fallback = event.target.dataset.fallback; if (fallback && event.target.src !== fallback) { delete event.target.dataset.fallback; event.target.src = fallback; } else event.target.remove(); } }, true);
  $('close-dialog').addEventListener('click', () => $('creator-dialog').close());
  $('creator-dialog').addEventListener('click', event => { if (event.target === $('creator-dialog')) $('creator-dialog').close(); });
  $('creator-dialog').addEventListener('close', () => {
    profileRequest?.abort();
    profileRequest = null;
    profileId = null;
    profileSnapshot = null;
  });
  $('dialog-content').addEventListener('click', event => {
    if (event.target.id === 'profile-post-more') {
      if (!moderationBusy) loadPosts();
      return;
    }
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
  if (admin) {
    $('dialog-content').addEventListener('submit', async event => {
      const form = event.target.closest('form[data-action]');
      if (!form) return;
      event.preventDefault();
      if (moderationBusy || profileRequest || !profileId || !profileSnapshot) return;
      const { action, post: postId } = form.dataset;
      const creator = profileId;
      const page = Number(form.closest('[data-post-page]')?.dataset.postPage || 1);
      const feedback = $('moderation-feedback');
      const button = form.querySelector('button[type="submit"]');
      moderationBusy = true;
      button.disabled = true;
      feedback.textContent = 'Saving…';
      try {
        await getData({}, null, { action, creator, postId, snapshotId: profileSnapshot, reason: form.elements.reason?.value });
        if (creator === profileId) {
          await loadPosts(page);
          feedback.textContent = { exclude: 'Post excluded.', restore: 'Post restored.', review: 'Review saved.' }[action];
        }
        loadBoard(boardPage);
      } catch (error) {
        if (error.status === 401) showAdminSignIn('Your session has expired.');
        else feedback.textContent = error.message;
      } finally {
        moderationBusy = false;
        if (button.isConnected && action !== 'review') button.disabled = false;
        if (button.isConnected && action === 'review' && feedback.textContent !== 'Review saved.' && profileSnapshot) button.disabled = false;
      }
    });
    $('review-filter').addEventListener('change', () => loadBoard(1));
  }
  $('search').addEventListener('input', () => {
    boardRequest?.abort();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadBoard(1), 220);
  });
  $('board-pagination').addEventListener('click', event => {
    const button = event.target.closest('button[data-page-number]');
    if (!button || button.disabled) return;
    const page = Number(button.dataset.pageNumber);
    if (page === boardPage) return;
    clearTimeout(searchTimer);
    loadBoard(page, true);
  });
  window.addEventListener('hashchange', showPage);
  window.addEventListener('resize', () => { if (!$('page-leaderboard').hidden) buildMap(); });

  function showAdminSignIn(message = '') {
    adminSignedIn = false;
    boardRequest?.abort();
    clearTimeout(searchTimer);
    $('creator-dialog').close();
    $('dialog-content').replaceChildren();
    $('leaderboard-body').replaceChildren();
    rows = [];
    leaders = [];
    loadedBoard = false;
    $('admin-sign-out').hidden = true;
    $('admin-access-status').textContent = message;
    $('admin-sign-in').hidden = false;
    showPage();
  }

  function openModeration() {
    adminSignedIn = true;
    $('admin-sign-in').hidden = true;
    $('admin-sign-out').hidden = false;
    showPage();
    loadBoard(1);
  }

  async function initAdmin() {
    document.body.classList.add('admin-mode');
    document.title = 'Moderation · Entropy Creators';
    $('public-navigation').hidden = true;
    $('explore-entropy').hidden = true;
    $('admin-public-link').hidden = false;
    $('review-filter-label').hidden = false;
    $('review-column').hidden = false;
    $('board-heading').textContent = 'Moderation';
    showPage();
    $('admin-sign-in-form').addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button');
      const key = $('admin-key').value;
      $('admin-key').value = '';
      $('admin-access-status').textContent = 'Signing in…';
      button.disabled = true;
      try {
        await getData({}, null, { action: 'login', key });
        openModeration();
      } catch (error) { $('admin-access-status').textContent = error.message; }
      finally { button.disabled = false; }
    });
    $('admin-sign-out').addEventListener('click', async () => {
      try { await getData({}, null, { action: 'logout' }); showAdminSignIn(); }
      catch (error) {
        if (error.status === 401) showAdminSignIn();
        else $('board-count').textContent = 'Could not sign out. Try again.';
      }
    });
    try {
      const session = await getData({ view: 'session' });
      if (session.authenticated) openModeration();
      else showAdminSignIn();
    } catch (error) { showAdminSignIn(error.message); }
  }

  if (admin) initAdmin();
  else { showPage(); loadBoard(1); }
})();
