(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const admin = /^\/admin\/?$/.test(location.pathname);
  const statsEnabled = !admin;
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
  const formatScore = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const compact = value => value === null ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const safeImage = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'pbs.twimg.com' && !u.port && !u.username && !u.password ? u.href : ''; } catch (_) { return ''; } };
  const avatar = person => { const url = safeImage(person.avatarUrl), initial = esc((person.displayName || person.handle || '?').trim().charAt(0).toUpperCase()); return url ? `<img class="avatar" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="avatar avatar-fallback" aria-hidden="true">${initial}</span>`; };
  let rows = [], leaders = [];
  let boardPage = 1;
  let boardRequest, searchTimer;
  let loadedBoard = false;
  let adminSignedIn = false;
  let boardMode = null;
  const earlyBadge = '<span class="early-badge" title="Posted about Entropy through November 16, 2026 (UTC)">Early</span>';
  const reviewDate = value => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value)) : '';

  function displayWeeks(select, data) {
    select.replaceChildren(...data.weeks.map(week => new Option(week.label, week.id)));
    select.value = data.week?.id ?? '';
    select.disabled = !data.weeks.length;
  }

  function showCampaignSummary(data) {
    displayWeeks($('campaign-week'), data);
    $('campaign-topic').textContent = data.week?.topic ?? 'Campaign weeks will appear here.';
    $('campaign-dates').textContent = data.week
      ? `${reviewDate(data.week.startsAt)} – ${reviewDate(new Date(Date.parse(data.week.endsAt) - 1))} · UTC` : '';
  }

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
    const rankedByScore = data.rankingMetric === 'score';
    $('score-column').hidden = !rankedByScore;
    $('rank-score-methodology').hidden = !rankedByScore;
    $('rank-views-methodology').hidden = rankedByScore;
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
        ${rankedByScore ? `<td class="num primary">${Number.isFinite(row.score) ? formatScore.format(row.score) : '—'}</td>` : ''}
        <td class="num">${format(row.postCount)}${admin && row.totalPosts > row.postCount ? `<small class="excluded-count">${format(row.totalPosts - row.postCount)} excluded</small>` : ''}</td>
        <td class="num${rankedByScore ? '' : ' primary'}">${format(row.views)}</td>
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
    if (!boardMode) return;
    const campaign = boardMode === 'campaign';
    const week = campaign ? $('campaign-week').value : '';
    boardRequest?.abort();
    const request = new AbortController();
    boardRequest = request;
    $('leaderboard-body').setAttribute('aria-busy', 'true');
    if (!loadedBoard) {
      $('load-status').hidden = false;
      $('load-status').textContent = 'Loading leaderboard…';
    }
    const q = $('search').value.trim();
    try {
      const status = admin ? $('review-filter').value : '';
      const data = await getData({ view: campaign ? 'campaign' : 'ranking', page,
        ...(week ? { week } : {}), ...(q ? { q } : {}), ...(status ? { status } : {}) }, request.signal);
      if (request.signal.aborted) return;
      if (campaign) showCampaignSummary(data);
      const mapChanged = !loadedBoard || JSON.stringify(leaders) !== JSON.stringify(data.leaders);
      leaders = data.leaders;
      $('creator-total').textContent = format(data.totals.creators);
      $('post-total').textContent = format(data.totals.posts);
      $('view-total').textContent = compact(data.totals.views);
      $('updated').textContent = data.asOf ? 'UPDATED ' + new Intl.DateTimeFormat('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
      }).format(new Date(data.asOf)).toUpperCase() : '—';
      $('empty').textContent = campaign && !q ? 'No qualifying posts for this week yet.' : 'No creators found. Try another handle.';
      buildTable(data);
      loadedBoard = true;
      $('load-status').hidden = true;
      if (!campaign && mapChanged && !$('page-leaderboard').hidden) buildMap();
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

  function renderPostText(post, fullId) {
    const text = (post.body || post.summary || 'Post text unavailable.').replace(/\r\n/g, '\n').trim();
    const firstLines = text.split('\n', 7).slice(0, 6).join('\n');
    const characters = Array.from(firstLines);
    const truncated = firstLines !== text || characters.length > 300;
    let preview = characters.slice(0, 300).join('');
    if (characters.length > 300) {
      const boundary = preview.search(/\s+\S*$/u);
      if (boundary > 240) preview = preview.slice(0, boundary);
    }
    return truncated
      ? `<p class="post-preview">${esc(preview.trimEnd())}…</p>
         <p id="${fullId}" class="post-full" hidden>${esc(text)}</p>
         <button type="button" class="post-toggle" aria-controls="${fullId}" aria-expanded="false">Show more</button>`
      : `<p>${esc(text)}</p>`;
  }

  function togglePostText(button) {
    const full = $(button.getAttribute('aria-controls'));
    const preview = button.closest('article').querySelector('.post-preview');
    const expand = full.hidden;
    full.hidden = !expand;
    preview.hidden = expand;
    button.setAttribute('aria-expanded', String(expand));
    button.textContent = expand ? 'Show less' : 'Show more';
  }

  function renderPost(post, index) {
    return `<article class="profile-post">
      ${renderPostText(post, `profile-post-text-${index}`)}
      <div class="profile-post-meta">
        <a href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">VIEW POST ↗</a>
        <time datetime="${esc(post.date)}">${esc(post.date)}</time>
      </div>
    </article>`;
  }

  let profileRequest;
  let profileId;
  let profileWeek;
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
      const result = await getData({ view: 'profile', creator: profileId, page,
        ...(profileWeek ? { week: profileWeek } : {}) }, request.signal);
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
        <div><span>${admin ? 'COUNTED POSTS' : boardMode === 'campaign' ? 'QUALIFYING POSTS' : 'INDEXED POSTS'}</span><strong id="profile-counted-posts">${format(row.postCount)}</strong></div>
        <div><span>TOTAL VIEWS</span><strong id="profile-views">${format(row.views)}</strong></div>
        <div><span>TOTAL LIKES</span><strong id="profile-likes">${format(row.likes)}</strong></div>
      </div>
      ${admin ? `<div class="moderation-review"><div id="moderation-review-status"></div>
        <form data-action="review"><button id="mark-reviewed" class="admin-button admin-button-primary" type="submit" disabled>Mark reviewed</button></form>
        <p id="moderation-feedback" role="status"></p></div>
        <details id="moderation-history" class="moderation-history" hidden><summary>Moderation history</summary><ul id="moderation-events"></ul></details>` : ''}
      <h3 class="profile-posts-title">${boardMode === 'campaign' ? 'Qualifying posts' : 'Indexed posts'}</h3>
      <div id="profile-posts" class="profile-posts"></div>
      <p id="profile-post-status" class="board-footer" role="status"></p>
      <button id="profile-post-more" class="post-toggle" type="button" hidden>Load more posts</button>`;
    profileId = id;
    profileWeek = boardMode === 'campaign' ? $('campaign-week').value : null;
    profileSnapshot = null;
    nextPostPage = 1;
    dialog.showModal();
    dialog.scrollTop = 0;
    loadPosts();
  }
  function resetBoard() {
    boardRequest?.abort();
    loadedBoard = false;
    rows = [];
    leaders = [];
    $('leaderboard-body').replaceChildren();
    $('empty').hidden = true;
    $('board-count').textContent = '';
    $('board-pagination').hidden = true;
    for (const id of ['creator-total', 'post-total', 'view-total', 'updated']) $(id).textContent = '—';
  }

  let weeklyRequest, weeklyBusy = false, weeklyPage = 1;
  const weeklyStatusNames = { match: 'Included', review: 'Needs review', off_topic: 'Excluded' };

  function weeklyCard(entry) {
    const { post, handle, status, choice, confidence, manualStatus, revision } = entry;
    const choices = ['match', 'off_topic', 'review'].filter(option => option !== status);
    const labels = { match: 'Include', off_topic: 'Exclude', review: 'Return to review' };
    const model = choice ? `Jev · ${weeklyStatusNames[choice]} · ${Math.round(confidence * 100)}% confidence` : 'No post text';
    return `<article class="profile-post">
      <div class="moderation-post-head">
        <a href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">@${esc(handle)} ↗</a>
        <time datetime="${esc(post.publishedAt)}">${esc(post.date)}</time>
      </div>
      <p class="campaign-post-body">${esc(post.body || 'Post text unavailable.')}</p>
      <div class="profile-post-meta"><span>${esc(model)}</span>${manualStatus ? '<span>Manually reviewed</span>' : ''}</div>
      <form class="board-controls campaign-actions" data-weekly-post="${esc(post.id)}" data-revision="${revision}">
        ${choices.map(option => `<button class="admin-button${option === 'match' ? ' admin-button-primary' : ''}"
          type="submit" value="${option}">${labels[option]}</button>`).join('')}
      </form>
    </article>`;
  }

  async function loadWeeklyReview(page = 1) {
    weeklyRequest?.abort();
    const request = new AbortController();
    weeklyRequest = request;
    const feedback = $('weekly-feedback');
    const week = $('weekly-week').value;
    const status = $('weekly-status-filter').value;
    $('weekly-posts').replaceChildren();
    $('weekly-pagination').hidden = true;
    $('weekly-page').textContent = '';
    feedback.textContent = 'Loading weekly review…';
    try {
      const data = await getData({ view: 'weekly', status, page, ...(week ? { week } : {}) }, request.signal);
      if (request.signal.aborted) return;
      displayWeeks($('weekly-week'), data);
      $('weekly-topic').textContent = data.week?.topic ?? '';
      $('weekly-counts').textContent = `${data.counts.review} need review · ${data.counts.match} included · ${data.counts.off_topic} excluded`;
      $('weekly-posts').innerHTML = data.posts.map(weeklyCard).join('');
      weeklyPage = data.page;
      $('weekly-pagination').hidden = data.totalPages <= 1;
      $('weekly-prev').disabled = weeklyPage <= 1;
      $('weekly-next').disabled = weeklyPage >= data.totalPages;
      $('weekly-page').textContent = data.totalPages > 1 ? `Page ${weeklyPage} of ${data.totalPages}` : '';
      feedback.textContent = data.posts.length ? '' : 'No posts with this status.';
    } catch (error) {
      if (request.signal.aborted) return;
      if (error.status === 401) return showAdminSignIn('Your session has expired.');
      feedback.textContent = error.message;
    }
  }

  let myStatsRequest, myStatsPostsRequest, rankHistoryObserver;
  const myStatsStorageKey = 'entropy.myStats.handle';
  const xHandle = /^[A-Za-z0-9_]{1,15}$/;
  const statsCount = value => value == null ? '—' : format(value);
  const rankNumber = rank => `#${format(rank)}`;

  function rankTrend(row) {
    if (row.newRank) return '<span class="stats-trend up">New</span>';
    if (row.rank === null && row.previousRank != null) return '<span class="stats-trend down">Out of ranking</span>';
    if (!Number.isInteger(row.rankChange)) return '';
    if (row.rankChange === 0) return '<span class="stats-trend">Unchanged</span>';
    const up = row.rankChange > 0;
    return `<span class="stats-trend ${up ? 'up' : 'down'}"><span aria-hidden="true">${up ? '↑' : '↓'}</span> ${up ? 'Up' : 'Down'} ${format(Math.abs(row.rankChange))}</span>`;
  }

  function yesterdayRank(row) {
    if (row.previousRank != null) return rankNumber(row.previousRank);
    return row.hasPreviousSnapshot ? 'Unranked' : 'No data';
  }

  function renderRankHistory(history) {
    const ranked = history.filter(({ rank }) => Number.isSafeInteger(rank));
    const summary = ranked.map(({ day, rank }) => `${reviewDate(day)} ${rankNumber(rank)}`).join(', ');
    return `<figure class="stats-rank-history${ranked.length < 2 ? ' stats-history-empty' : ''}">
      <figcaption><strong>Rank history</strong><span>7 days · UTC</span></figcaption>
      ${ranked.length >= 2 ? `<canvas id="stats-rank-chart" role="img" aria-label="${esc(summary)}" title="${esc(summary)}"></canvas>
        <div class="stats-chart-axis" aria-hidden="true"><span>${esc(reviewDate(history[0].day))}</span><span>Today</span></div>`
        : '<p>Rank history appears once two days of rankings are available.</p>'}
    </figure>`;
  }

  function watchRankChart(history) {
    const canvas = $('stats-rank-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ranks = history.map(({ rank }) => rank).filter(Number.isSafeInteger);
    const best = Math.min(...ranks), worst = Math.max(...ranks);
    const step = Math.max(1, Math.ceil((worst - best) / 2));
    const top = Math.max(1, best - step), bottom = worst + step + 1;

    rankHistoryObserver = new ResizeObserver(() => {
      const { clientWidth: width, clientHeight: height } = canvas;
      if (!width || !height) return;
      const pixelRatio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      ctx.scale(pixelRatio, pixelRatio);
      const left = 49, right = width - 7;
      const x = i => left + (right - left) * i / (history.length - 1);
      const y = rank => 11 + (height - 22) * (rank - top) / (bottom - top);
      ctx.font = '10px monospace';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#a3b7aa';
      ctx.strokeStyle = '#a8d6ba24';
      for (const rank of [top, Math.round((top + bottom) / 2), bottom]) {
        ctx.fillText(rankNumber(rank), 0, y(rank), left - 5);
        ctx.beginPath();
        ctx.moveTo(left, y(rank));
        ctx.lineTo(right, y(rank));
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.strokeStyle = '#b3f6cb';
      ctx.lineWidth = 2;
      let consecutive = false;
      history.forEach(({ rank }, i) => {
        if (rank === null) { consecutive = false; return; }
        if (consecutive) ctx.lineTo(x(i), y(rank)); else ctx.moveTo(x(i), y(rank));
        consecutive = true;
      });
      ctx.stroke();
      history.forEach(({ rank }, i) => {
        if (rank === null) return;
        ctx.beginPath();
        ctx.fillStyle = i === history.length - 1 ? '#d5ffdf' : '#a5dfb9';
        ctx.arc(x(i), y(rank), i === history.length - 1 ? 4 : 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    });
    rankHistoryObserver.observe(canvas);
  }

  function renderStatsPost(post, top = false) {
    const text = renderPostText(post, `stats-post-text-${esc(post.id)}`);
    const metrics = `<div class="stats-post-metrics">
        <dl><div><dt>Post score</dt><dd>${post.score == null ? '—' : formatScore.format(post.score)}</dd></div>
          <div><dt>Views</dt><dd>${statsCount(post.metrics.impressions)}</dd></div></dl>
        ${top ? '' : `<a href="${esc(post.url)}" target="_blank" rel="noopener noreferrer">View on X <span aria-hidden="true">↗</span></a>`}
      </div>`;
    return `<article class="${top ? 'my-stats-top' : 'profile-post'}">${top ? metrics + text : text + metrics}</article>`;
  }

  function renderMyStats(account, stats) {
    const { overall, weeks, smartFollowers, topPost, rankHistory = [] } = stats;
    const otherPosts = overall.postCount - Number(Boolean(topPost));
    const podium = overall.rank !== null && overall.rank <= 3;
    const rankStyle = overall.rank === null ? 'stats-unranked' : podium ? `rank-podium rank-podium-${overall.rank} stats-podium` : '';
    const away = '<span aria-hidden="true">↗</span>';
    const weekBadges = weeks.filter(week => week.postCount > 0)
      .map(week => `<span class="stats-week-badge" title="${esc(week.label)} participant">${esc(week.label)}</span>`).join('');
    $('my-stats-content').innerHTML = `
      <section class="my-stats-panel stats-rank-card" aria-labelledby="my-stats-overall-heading">
        <div class="stats-rank-summary">
          <div class="profile-hero my-stats-identity">
            ${avatar(account)}
            <div><div class="creator-name-line"><strong>${esc(account.displayName)}</strong>${overall.early ? earlyBadge : ''}${weekBadges}</div>
              <a href="https://x.com/${esc(account.handle)}" target="_blank" rel="noopener noreferrer">@${esc(account.handle)} ${away}</a>
            </div>
          </div>
          <div class="stats-overall-position">
            <h2 id="my-stats-overall-heading">Overall rank</h2>
            <div class="stats-rank-line">
              <strong class="${rankStyle}">${overall.rank === null ? 'Unranked' : `<span aria-hidden="true">#</span>${format(overall.rank)}`}</strong>
              ${rankTrend(overall)}
            </div>
            <p class="stats-comparison">Yesterday (UTC) <span>${yesterdayRank(overall)}</span></p>
          </div>
        </div>
        ${renderRankHistory(rankHistory)}
      </section>
      <dl class="my-stats-panel my-stats-metrics">
        <div><dt>Creator Score</dt><dd>${overall.score === null ? '—' : formatScore.format(overall.score)}</dd></div>
        <div><dt>Total views</dt><dd>${statsCount(overall.views)}</dd></div>
        <div><dt>Smart Followers</dt><dd>${statsCount(smartFollowers)}</dd></div>
      </dl>
      <div class="my-stats-details">
        <section class="my-stats-panel" aria-labelledby="my-stats-weekly-heading">
          <div class="stats-panel-heading"><h2 id="my-stats-weekly-heading">Weekly rankings</h2></div>
          ${weeks.length ? `<table class="my-stats-weeks">
            <thead><tr><th scope="col">Campaign</th><th scope="col">Rank</th><th scope="col">Vs. yesterday</th></tr></thead>
            <tbody>${weeks.map(week => `<tr>
              <th scope="row"><strong>${esc(week.label)}</strong><span>${format(week.postCount)} qualifying ${week.postCount === 1 ? 'post' : 'posts'}</span></th>
              <td>${week.rank === null ? '<span class="my-stats-muted">Unranked</span>' : week.rank <= 3
                ? `<span class="rank rank-podium rank-podium-${week.rank}">${week.rank}</span>` : rankNumber(week.rank)}</td>
              <td title="Yesterday (UTC) · ${yesterdayRank(week)}">${rankTrend(week) || `<span class="my-stats-muted" aria-label="${yesterdayRank(week)}">—</span>`}</td>
            </tr>`).join('')}</tbody>
          </table>` : '<p class="stats-panel-empty">No campaign weeks yet.</p>'}
        </section>
        <section class="my-stats-panel" aria-labelledby="my-stats-top-heading">
          <div class="stats-panel-heading"><h2 id="my-stats-top-heading">Top-scoring post</h2>
            ${topPost ? `<a href="${esc(topPost.url)}" target="_blank" rel="noopener noreferrer">View on X ${away}</a>` : ''}
          </div>
          ${topPost ? renderStatsPost(topPost, true) : '<p class="stats-panel-empty">No scored posts yet.</p>'}
          ${otherPosts > 0 ? `<details class="stats-posts-disclosure" data-stats-author="${esc(account.id)}" data-next-page="1">
            <summary>${topPost ? 'Other posts' : 'Indexed posts'} <span>${format(otherPosts)}</span></summary>
            <div class="stats-posts-body">
              <div class="profile-posts stats-posts-list" role="region" aria-label="Creator posts" tabindex="0"></div>
              <p class="my-stats-feedback stats-posts-status" role="status"></p>
              <button type="button" class="admin-button stats-posts-more" hidden>Load more posts</button>
            </div>
          </details>` : ''}
        </section>
      </div>`;
  }

  async function loadMyStatsPosts(details) {
    if (myStatsPostsRequest || !details.open) return;
    const request = myStatsPostsRequest = new AbortController();
    const list = details.querySelector('.stats-posts-list');
    const status = details.querySelector('.stats-posts-status');
    const more = details.querySelector('.stats-posts-more');
    const page = Number(details.dataset.nextPage);
    status.textContent = 'Loading posts…';
    more.disabled = true;
    try {
      const result = await getData({ view: 'posts', creator: details.dataset.statsAuthor, page }, request.signal);
      if (request.signal.aborted) return;
      list.insertAdjacentHTML('beforeend', result.posts.map(post => renderStatsPost(post)).join(''));
      details.dataset.nextPage = String(result.page + 1);
      status.textContent = page === 1 && !result.posts.length ? 'No other indexed posts.' : '';
      more.textContent = 'Load more posts';
      more.hidden = result.page >= result.totalPages;
    } catch {
      if (request.signal.aborted) return;
      status.textContent = 'Could not load posts.';
      more.textContent = 'Try again';
      more.hidden = false;
    } finally {
      more.disabled = false;
      if (myStatsPostsRequest === request) myStatsPostsRequest = null;
    }
  }

  function restoreMyStats() {
    const input = $('my-stats-handle');
    if (!input.value) {
      try {
        const saved = localStorage.getItem(myStatsStorageKey);
        if (saved && xHandle.test(saved)) input.value = saved;
      } catch { /* Storage can be disabled by the browser. */ }
    }
    if (input.value && $('my-stats-content').hidden && $('my-stats-feedback').hidden) loadMyStats();
  }

  async function loadMyStats() {
    myStatsRequest?.abort();
    myStatsPostsRequest?.abort();
    myStatsPostsRequest = null;
    rankHistoryObserver?.disconnect();
    const input = $('my-stats-handle');
    const handle = input.value.trim().replace(/^@/, '');
    const feedback = $('my-stats-feedback');
    const content = $('my-stats-content');
    content.hidden = true;
    feedback.hidden = false;
    if (!xHandle.test(handle)) {
      feedback.textContent = 'Enter a valid X username.';
      return;
    }
    const request = myStatsRequest = new AbortController();
    feedback.textContent = 'Loading creator stats…';
    try {
      const data = await getData({ view: 'stats', q: handle }, request.signal);
      if (request.signal.aborted) return;
      renderMyStats(data.account, data.stats);
      if (input.value.trim().replace(/^@/, '').toLowerCase() === handle.toLowerCase()) input.value = data.account.handle;
      try { localStorage.setItem(myStatsStorageKey, data.account.handle); }
      catch { /* Searching still works without storage. */ }
      content.hidden = false;
      watchRankChart(data.stats.rankHistory ?? []);
      feedback.textContent = '';
      feedback.hidden = true;
    } catch (error) {
      if (!request.signal.aborted) feedback.textContent = error.status === 404
        ? 'This username isn’t on the leaderboard yet.' : 'Creator stats are temporarily unavailable. Try again.';
    } finally {
      if (myStatsRequest === request) myStatsRequest = null;
    }
  }

  function showPage() {
    const hash = location.hash.slice(1);
    const key = admin ? (adminSignedIn ? (hash === 'weekly-review' ? hash : 'leaderboard') : '')
      : ['leaderboard', 'campaign', 'methodology', 'about'].includes(hash) || (statsEnabled && hash === 'my-stats') ? hash : 'leaderboard';
    const campaign = key === 'campaign';
    const board = campaign || key === 'leaderboard';
    document.querySelectorAll('.page').forEach(el => { el.hidden = el.id !== 'page-' + (campaign ? 'leaderboard' : key); });
    document.querySelectorAll('[data-page]').forEach(el => { el.classList.toggle('active', el.dataset.page === key); if (el.dataset.page === key) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
    $('load-status').hidden = !board || loadedBoard;
    $('map-section').hidden = campaign;
    $('campaign-intro').hidden = !campaign;
    $('post-total-label').textContent = campaign ? 'POSTS INCLUDED' : 'POSTS INDEXED';
    $('board-title').textContent = admin ? 'Moderation' : campaign ? 'Weekly leaderboard' : 'Leaderboard';
    if (key === 'weekly-review') loadWeeklyReview();
    else weeklyRequest?.abort();
    if (key === 'my-stats') restoreMyStats();
    else if (myStatsRequest) {
      myStatsRequest.abort();
      $('my-stats-feedback').hidden = true;
    }
    if (!board) {
      boardRequest?.abort();
      boardMode = null;
      return;
    }
    if (boardMode !== key) {
      boardMode = key;
      clearTimeout(searchTimer);
      $('search').value = '';
      resetBoard();
      loadBoard(1);
    }
    if (key === 'leaderboard' && loadedBoard) buildMap();
  }
  document.addEventListener('click', event => { const target = event.target.closest('[data-creator]'); if (target) openCreator(target.dataset.creator); });
  document.addEventListener('keydown', event => { const target = event.target.closest('tr[data-creator]'); if (target && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openCreator(target.dataset.creator); } if (event.key === '/' && boardMode && !event.target.matches('input,textarea,select')) { event.preventDefault(); $('search').focus(); } });
  document.addEventListener('error', event => { if (event.target.matches?.('img.avatar')) { const replacement = document.createElement('span'); replacement.className = 'avatar avatar-fallback'; replacement.textContent = '?'; event.target.replaceWith(replacement); } else if (event.target.closest?.('.map-tile') && event.target.tagName === 'IMG') { const fallback = event.target.dataset.fallback; if (fallback && event.target.src !== fallback) { delete event.target.dataset.fallback; event.target.src = fallback; } else event.target.remove(); } }, true);
  $('close-dialog').addEventListener('click', () => $('creator-dialog').close());
  $('creator-dialog').addEventListener('click', event => { if (event.target === $('creator-dialog')) $('creator-dialog').close(); });
  $('creator-dialog').addEventListener('close', () => {
    profileRequest?.abort();
    profileRequest = null;
    profileId = null;
    profileWeek = null;
    profileSnapshot = null;
  });
  $('dialog-content').addEventListener('click', event => {
    if (event.target.id === 'profile-post-more') {
      if (!moderationBusy) loadPosts();
      return;
    }
    const button = event.target.closest('.post-toggle');
    if (button) togglePostText(button);
  });
  if (admin) {
    $('weekly-week').addEventListener('change', () => loadWeeklyReview());
    $('weekly-status-filter').addEventListener('change', () => loadWeeklyReview());
    $('weekly-prev').addEventListener('click', () => loadWeeklyReview(weeklyPage - 1));
    $('weekly-next').addEventListener('click', () => loadWeeklyReview(weeklyPage + 1));
    $('weekly-posts').addEventListener('submit', async event => {
      const form = event.target.closest('form[data-weekly-post]');
      if (!form) return;
      event.preventDefault();
      if (weeklyBusy || !event.submitter) return;
      weeklyBusy = true;
      for (const button of form.querySelectorAll('button')) button.disabled = true;
      try {
        await getData({}, null, { action: 'campaign-review', week: $('weekly-week').value,
          postId: form.dataset.weeklyPost, revision: Number(form.dataset.revision), status: event.submitter.value });
        if (location.hash === '#weekly-review') await loadWeeklyReview(weeklyPage);
      } catch (error) {
        if (error.status === 401) showAdminSignIn('Your session has expired.');
        else $('weekly-feedback').textContent = error.message;
      } finally {
        weeklyBusy = false;
        for (const button of form.querySelectorAll('button')) button.disabled = false;
      }
    });
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
  $('campaign-week').addEventListener('change', () => {
    resetBoard();
    loadBoard(1);
  });
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
  window.addEventListener('resize', () => { if (boardMode === 'leaderboard') buildMap(); });

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
    $('admin-navigation').hidden = true;
    $('admin-access-status').textContent = message;
    $('admin-sign-in').hidden = false;
    showPage();
  }

  function openModeration() {
    adminSignedIn = true;
    $('admin-sign-in').hidden = true;
    $('admin-sign-out').hidden = false;
    $('admin-navigation').hidden = false;
    showPage();
  }

  async function initAdmin() {
    document.body.classList.add('admin-mode');
    document.title = 'Moderation · Entropy Creators';
    $('public-navigation').hidden = true;
    $('explore-entropy').hidden = true;
    $('admin-public-link').hidden = false;
    $('review-filter-label').hidden = false;
    $('review-column').hidden = false;
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

  if (statsEnabled) {
    $('my-stats-nav').hidden = false;
    const content = $('my-stats-content');
    content.addEventListener('toggle', event => {
      const details = event.target;
      if (details.matches('.stats-posts-disclosure') && details.open && details.dataset.nextPage === '1') loadMyStatsPosts(details);
    }, true);
    content.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (button?.classList.contains('post-toggle')) togglePostText(button);
      if (button?.classList.contains('stats-posts-more')) loadMyStatsPosts(button.closest('details'));
    });
    $('my-stats-form').addEventListener('submit', event => {
      event.preventDefault();
      loadMyStats();
    });
  }
  if (admin) initAdmin();
  else showPage();
})();
