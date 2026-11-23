/* 回顾页:今日回顾 / 全部书签 / 设置。数据全部向后台要(rpc),页面自己不存任何东西。
 * 书签内容是不可信的外部文本:一律用 textContent / createTextNode,绝不拼 innerHTML。 */
(function () {
  'use strict';

  /* ================= 小工具 ================= */
  const $ = (s, el) => (el || document).querySelector(s);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function rpc(type, payload) {
    const r = await chrome.runtime.sendMessage(Object.assign({ type }, payload || {}));
    if (!r || !r.ok) throw new Error((r && r.error) || '后台没有响应,请再试一次');
    return r.data;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const fmtDay = (d) => d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  const fmtLong = (d) => d.getMonth() + 1 + '月' + d.getDate() + '日 星期' + WEEK[d.getDay()];
  const dayKeyNow = () => {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };
  function fmtClock(ms) {
    const d = new Date(ms);
    const same = d.toDateString() === new Date().toDateString();
    return (same ? '今天 ' : d.getMonth() + 1 + '月' + d.getDate() + '日 ') + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function ago(ms) {
    const days = Math.floor((Date.now() - ms) / 86400000);
    if (days < 1) return '今天';
    if (days < 2) return '昨天';
    if (days < 30) return days + ' 天前';
    if (days < 365) return Math.floor(days / 30) + ' 个月前';
    return Math.floor(days / 365) + ' 年前';
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const svg = (d) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  const ICON = {
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    link: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    mute: svg('<path d="M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 6c5 0 8.5 4.2 9.5 6-.4.8-1.2 1.9-2.3 3M6.5 7.6C4.5 9 3.2 10.8 2.5 12c1 1.8 4.5 6 9.5 6 1.5 0 2.8-.4 4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
    restore: svg('<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/>'),
    bookmark: svg('<path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4.5L5 20V5a1 1 0 0 1 1-1z"/>'),
    heart: svg('<path d="M12 20.2s-7.6-4.7-9.6-9.4A5.2 5.2 0 0 1 12 6.4a5.2 5.2 0 0 1 9.6 4.4c-2 4.7-9.6 9.4-9.6 9.4z"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/>'),
    chevL: svg('<path d="M15 5l-7 7 7 7"/>'),
    chevR: svg('<path d="M9 5l7 7-7 7"/>'),
  };
  function icon(name) {
    const s = document.createElement('span');
    s.className = 'ico';
    s.innerHTML = ICON[name]; // 常量 SVG,不含任何外部数据
    return s;
  }

  let toastTimer = 0;
  function toast(text, action) {
    const t = $('#toast');
    t.textContent = '';
    t.append(h('span', { text }));
    if (action) {
      t.append(
        h('button', {
          class: 'toast-act',
          type: 'button',
          text: action.label,
          onclick: () => {
            hideToast();
            action.fn();
          },
        })
      );
    }
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add('on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6500 : 2600);
  }
  function hideToast() {
    const t = $('#toast');
    t.classList.remove('on');
    setTimeout(() => {
      if (!t.classList.contains('on')) t.hidden = true;
    }, 220);
  }

  /* ================= 正文:链接 / @ / # ================= */
  const TOKEN = /(https?:\/\/[^\s<>"'，。！？、）】》]+)|((?<![\p{L}\p{N}_/])@[A-Za-z0-9_]{1,15})|((?<![\p{L}\p{N}_/&])#[\p{L}\p{N}_]{1,60})/gu;
  function shortUrl(u) {
    try {
      const x = new URL(u);
      const s = x.host.replace(/^www\./, '') + (x.pathname !== '/' ? x.pathname : '') + x.search;
      return s.length > 42 ? s.slice(0, 41) + '…' : s;
    } catch (_) {
      return u;
    }
  }
  function aLink(href, text) {
    return h('a', { href, target: '_blank', rel: 'noopener noreferrer', text });
  }
  function linkify(text) {
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      let raw = m[0];
      let tail = '';
      if (m[1]) {
        const t = /[.,;:!?)\]}]+$/.exec(raw);
        if (t) {
          tail = t[0];
          raw = raw.slice(0, -tail.length);
        }
        frag.append(aLink(raw, shortUrl(raw)));
      } else if (m[2]) {
        frag.append(aLink('https://x.com/' + raw.slice(1), raw));
      } else {
        frag.append(aLink('https://x.com/hashtag/' + encodeURIComponent(raw.slice(1)), raw));
      }
      if (tail) frag.append(tail);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  /* ================= 卡片 ================= */
  const httpsOnly = (u) => typeof u === 'string' && /^https:\/\//.test(u);
  const hostOf = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  };

  /** X 的图片服务器:不写尺寸时给的是中等大小的图。今日回顾一次只看一张,要看得清,所以要 large */
  function photoSrc(u) {
    try {
      const x = new URL(u);
      if (x.hostname === 'pbs.twimg.com' && x.pathname.startsWith('/media/') && !x.searchParams.has('name')) {
        x.searchParams.set('name', 'large');
        return x.href;
      }
    } catch (_) {}
    return u;
  }
  /** 有宽高就写进 width/height:浏览器先按比例留好位置,图片载入时页面不会跳 */
  function sizeAttrs(w, hgt) {
    w = Math.round(w);
    hgt = Math.round(hgt);
    return w > 0 && hgt > 0 ? { width: w, height: hgt } : {};
  }

  /** 图片/视频:完整显示(不裁切)、缩放到合适大小,不用点开看;多张就竖着排 */
  function renderMedia(item, o) {
    const list = (item.media || []).filter((m) => m && httpsOnly(m.url)).slice(0, 4);
    if (!list.length) return null;
    const loading = o && o.lazy ? 'lazy' : 'eager';
    const box = h('div', { class: 'media' + (list.length > 1 ? ' many' : '') });
    for (const m of list) {
      const gif = m.type === 'animated_gif';
      if ((m.type === 'video' || gif) && httpsOnly(m.video)) {
        box.append(
          h(
            'figure',
            { class: 'shot' },
            h('video', Object.assign({ src: m.video, poster: m.url, controls: true, preload: 'none', playsinline: true, loop: gif, muted: gif }, sizeAttrs(m.w, m.h)))
          )
        );
      } else if (m.type === 'video' || gif) {
        box.append(
          h(
            'a',
            { class: 'shot vposter', href: item.url, target: '_blank', rel: 'noopener noreferrer', title: '在 X 观看' },
            h('img', Object.assign({ src: m.url, alt: '视频封面', loading, referrerpolicy: 'no-referrer' }, sizeAttrs(m.w, m.h)))
          )
        );
      } else {
        box.append(
          h(
            'figure',
            { class: 'shot' },
            h('img', Object.assign({ src: photoSrc(m.url), alt: m.alt || '图片', loading, decoding: 'async', referrerpolicy: 'no-referrer' }, sizeAttrs(m.w, m.h)))
          )
        );
      }
    }
    return box;
  }

  /** 链接卡片 / X 长文章:把标题显示清楚,整张卡片点开去原文 */
  function renderLinkCard(item, o) {
    const c = item.card;
    if (!c || !c.title) return null;
    const article = c.kind === 'article';
    const href = /^https?:\/\//.test(c.url || '') ? c.url : item.url;
    const domain = c.domain || hostOf(href);
    return h(
      'a',
      { class: 'linkcard' + (article ? ' article' : ''), href, target: '_blank', rel: 'noopener noreferrer' },
      httpsOnly(c.image)
        ? h('img', Object.assign({ class: 'lc-img', src: c.image, alt: '', loading: o && o.lazy ? 'lazy' : 'eager', referrerpolicy: 'no-referrer' }, sizeAttrs(c.w, c.h)))
        : null,
      h(
        'div',
        { class: 'lc-body' },
        h('div', { class: 'lc-kind', text: article ? 'X 文章' : domain }),
        h('div', { class: 'lc-title', text: c.title }),
        c.desc ? h('div', { class: 'lc-desc', text: c.desc }) : null,
        h('div', { class: 'lc-foot' }, icon('link'), h('span', { text: article ? '点开阅读全文' : '打开链接' }))
      )
    );
  }

  function renderQuote(q) {
    const qm = q.media && q.media[0];
    return h(
      'a',
      { class: 'quote', href: q.url, target: '_blank', rel: 'noopener noreferrer' },
      h('div', { class: 'qn' }, q.name || q.handle || '', h('span', { class: 'qh', text: q.handle ? '@' + q.handle : '' })),
      q.text ? h('div', { class: 'qt', text: q.text }) : null,
      qm && httpsOnly(qm.url) ? h('img', { class: 'qimg', src: qm.url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null
    );
  }

  function act(label, ic, cls, fn) {
    return h('button', { class: 'act ' + (cls || ''), type: 'button', onclick: fn }, icon(ic), h('span', { text: label }));
  }

  function paintLike(card, on) {
    const b = card.querySelector('.act.like');
    if (!b) return;
    b.classList.toggle('is-liked', on);
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('span:last-child').textContent = on ? '已赞' : '点赞';
  }

  /** 点赞只记在本机(不会去 X 上点赞)。先改界面,存失败了再改回去 */
  async function toggleLike(item, card) {
    const on = !item.liked;
    item.liked = on;
    paintLike(card, on);
    try {
      await rpc('like', { id: item.id, liked: on });
    } catch (e) {
      item.liked = !on;
      paintLike(card, !on);
      toast('没能保存:' + e.message);
    }
  }

  /**
   * o: { mode: 'today' | 'library', done, lazy,
   *      onLike(item, card), onMute(item, card), onUnmute, onDelete(item, card), onRestore }
   */
  function renderCard(item, o) {
    o = o || {};
    const card = h('article', { class: 'card' + (o.done ? ' done' : ''), 'data-id': item.id });

    const initial = (item.name || item.handle || '?').trim().slice(0, 1).toUpperCase();
    const avatar = h('div', { class: 'avatar' }, initial);
    if (httpsOnly(item.avatar)) {
      const img = h('img', { src: item.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.remove()); // 头像加载失败就露出首字母
      avatar.append(img);
    }
    const posted = item.createdAt ? '发布于 ' + fmtDay(new Date(item.createdAt)) : '';
    const saved = item.bookmarkedAt ? '收藏于 ' + fmtDay(new Date(item.bookmarkedAt)) : '';
    card.append(
      h(
        'div',
        { class: 'who' },
        avatar,
        h(
          'div',
          { class: 'who-main' },
          h('div', { class: 'name' }, h('span', { class: 'nm', text: item.name || item.handle || '未知用户' })),
          h('div', { class: 'handle', text: item.handle ? '@' + item.handle : '' })
        ),
        o.done ? h('span', { class: 'chip-done', text: '✓ 已回顾' }) : null,
        h('div', { class: 'when', title: [posted, saved].filter(Boolean).join(' · '), text: item.bookmarkedAt ? '收藏于 ' + ago(item.bookmarkedAt) : posted })
      )
    );
    if (item.replyTo) card.append(h('div', { class: 'reply', text: '回复 @' + item.replyTo }));
    if (item.text) card.append(h('div', { class: 'text' }, linkify(item.text)));
    const media = renderMedia(item, o);
    if (media) card.append(media);
    const lc = renderLinkCard(item, o);
    if (lc) card.append(lc);
    if (item.quoted) card.append(renderQuote(item.quoted));

    const foot = h('div', { class: 'foot' });
    foot.append(
      h(
        'button',
        { class: 'act like' + (item.liked ? ' is-liked' : ''), type: 'button', 'aria-pressed': String(!!item.liked), onclick: () => o.onLike && o.onLike(item, card) },
        icon('heart'),
        h('span', { text: item.liked ? '已赞' : '点赞' })
      )
    );
    foot.append(h('a', { class: 'act', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), h('span', { text: '在 X 打开' })));
    foot.append(h('span', { class: 'spacer' }));
    if (o.mode === 'today') {
      if (item.reviewCount > 0) {
        const reviewedToday = window.XBR_PLAN.dayKey(new Date(item.lastReviewedAt)) === S.state.today;
        const priorReviews = item.reviewCount - Number(reviewedToday);
        if (priorReviews > 0) foot.append(h('span', { class: 'shown', text: '此前回顾 ' + priorReviews + ' 次' }));
      }
      foot.append(act('不再回顾', 'mute', '', () => o.onMute(item, card)));
      foot.append(act('删除', 'trash', 'danger', () => o.onDelete(item, card)));
    } else if (item.deleted) {
      foot.append(h('span', { class: 'shown', text: '已删除' }));
      foot.append(act('恢复', 'restore', 'ok', () => o.onRestore(item, card)));
    } else {
      if (item.removed) foot.append(h('span', { class: 'shown', text: '已在 X 取消收藏' }));
      else if (item.muted) foot.append(act('恢复回顾', 'restore', 'ok', () => o.onUnmute(item, card)));
      else foot.append(act('不再回顾', 'mute', '', () => o.onMute(item, card)));
      foot.append(act('删除', 'trash', 'danger', () => o.onDelete(item, card)));
    }
    card.append(foot);
    return card;
  }

  /* ================= 全局状态 ================= */
  const S = {
    tab: 'today',
    state: null,
    lib: { q: '', filter: 'active', items: [], total: 0, counts: null },
  };
  // 今日回顾的翻页状态。idx = 当前第几条(等于总数就是「看完了」那一页);
  // curId / atEnd 让页面重新绘制(同步完成、撤销、切页签回来)之后仍停在原来那张
  const T = { idx: 0, curId: null, atEnd: false, focus: null, day: '', vp: null, prev: null, next: null, bar: null, num: null, sub: null, progress: null, hideResync: false };
  const todaySub = (n) => fmtLong(new Date()) + (n ? ' · 今天抽到 ' + n + ' 条' : '');

  async function loadState(view) {
    S.state = await rpc('state', { view: !!view });
    if (S.state.sync && S.state.sync.running) setBanner('同步进行中…请到 X 书签页看进度', 'busy');
    return S.state;
  }

  async function refresh() {
    try {
      await loadState(S.tab === 'today');
      if (S.tab === 'today') renderToday();
      else if (S.tab === 'settings') renderSettings();
      else await loadLibrary(true);
    } catch (e) {
      showFatal(e);
    }
  }

  function showFatal(e) {
    const root = $('#view-' + S.tab);
    root.textContent = '';
    root.append(
      h('div', { class: 'empty' }, h('h2', { text: '没能加载' }), h('p', { text: String((e && e.message) || e) }), h('button', { class: 'btn', type: 'button', text: '重试', onclick: refresh }))
    );
  }

  function setBanner(text, kind) {
    const b = $('#banner');
    if (!text) {
      b.hidden = true;
      return;
    }
    b.className = 'banner' + (kind ? ' ' + kind : '');
    b.textContent = text;
    b.hidden = false;
  }

  /* ================= 今日回顾:一次一条 ================= */
  function emptyBox(title, body, btn) {
    return h(
      'div',
      { class: 'empty' },
      h('div', { class: 'art' }, icon('bookmark')),
      h('h2', { text: title }),
      h('p', { text: body }),
      btn || null
    );
  }

  function onboarding() {
    const box = emptyBox(
      '先把 X 书签读进来',
      '扩展会打开 x.com 的书签页,自动往下滚动并读取。需要你已经在这个浏览器里登录了 X;读到的内容只存在这台电脑上。',
      h('button', { class: 'btn btn-primary', type: 'button', text: '同步 X 书签', onclick: () => startSync('incremental') })
    );
    box.append(h('p', { class: 'hint', text: '第一次可能要 1–3 分钟,取决于书签数量;期间请让那个标签页留在前台。之后你在 X 上新收藏的书签会自动收进来。' }));
    return box;
  }

  /** 这次更新新增了「文章/链接的标题」,更新前收进来的书签缺这些信息,要重新同步一次才有 */
  function resyncNotice(n) {
    return h(
      'div',
      { class: 'notice' },
      h('div', { class: 'nt' }, h('b', { text: '要给旧书签补一下标题' }), h('span', { text: '这次更新让文章、链接的标题能显示了。之前收进来的 ' + n + ' 条还没有这些信息,做一次「完整同步」就补上(几分钟,期间请让 X 那个标签页留在前台)。' })),
      h(
        'div',
        { class: 'nb' },
        h('button', { class: 'btn btn-primary', type: 'button', text: '完整同步', onclick: () => startSync('full') }),
        h('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: '稍后',
          onclick: () => {
            T.hideResync = true;
            renderToday();
          },
        })
      )
    );
  }

  function moreRow(st) {
    return h(
      'div',
      { class: 'more' },
      h('button', { class: 'btn', type: 'button', text: '再来 4 条', onclick: moreItems }),
      h('button', { class: 'btn btn-ghost', type: 'button', text: '重新抽取今天的', onclick: reroll }),
      h('div', { class: 'hint', text: '书签池共 ' + st.counts.eligible + ' 条 · 每日目标 ' + st.settings.dailyCount + ' 条 · 约 ⅔ 新内容，⅓ 间隔复习' })
    );
  }

  function updateProgress() {
    const st = S.state;
    if (!st || !T.vp) return;
    const n = st.items.length;
    const done = st.items.filter((i) => st.plan.done[i.id]).length;
    if (T.bar) T.bar.style.width = n ? Math.round((done / n) * 100) + '%' : '0%';
    if (T.num) T.num.textContent = T.idx < n ? '第 ' + (T.idx + 1) + ' / ' + n + ' 条 · 已回顾 ' + done : '这 ' + n + ' 条都看完了';
    if (T.sub) T.sub.textContent = todaySub(n); // 不再回顾 / 删除之后,「今天抽到几条」也跟着变
  }

  /** 翻过去 = 回顾过了。先改界面再存;存失败了再改回去 */
  async function markReviewed(item) {
    const done = S.state.plan.done;
    if (done[item.id]) return;
    done[item.id] = Date.now();
    try {
      await rpc('done', { id: item.id, done: true });
    } catch (e) {
      delete done[item.id];
      updateProgress();
      toast('没能保存「已回顾」:' + e.message);
    }
  }

  function finishPanel() {
    const st = S.state;
    const n = st.items.length;
    const liked = st.items.filter((i) => i.liked).length;
    return h(
      'div',
      { class: 'slide finish' },
      h('div', { class: 'fin-art' }, icon('check')),
      h('h2', { text: '今天这批回顾完了' }),
      h('p', { text: '看了 ' + n + ' 条' + (liked ? ' · 点赞 ' + liked + ' 条' : '') }),
      h(
        'div',
        { class: 'fin-btns' },
        h('button', { class: 'btn btn-primary fin-more', type: 'button', text: '再来 4 条', onclick: moreItems }),
        h('button', {
          class: 'btn',
          type: 'button',
          text: '从头再看一遍',
          onclick: () => {
            T.idx = 0;
            paintSlide(-1);
          },
        })
      ),
      h('p', { class: 'hint', text: '明天会自动抽新的一批。' })
    );
  }

  /** 画出当前这一条(或「看完了」页)。dir:1 从右边滑入,-1 从左边滑入,0 不动画 */
  function paintSlide(dir) {
    const st = S.state;
    if (!st || !T.vp) return;
    const items = st.items;
    const n = items.length;
    T.idx = clamp(T.idx, 0, n);
    let node;
    if (T.idx < n) {
      const it = items[T.idx];
      node = h(
        'div',
        { class: 'slide' },
        renderCard(it, { mode: 'today', done: !!st.plan.done[it.id], onLike: toggleLike, onMute: (i) => takeOut(i, 'muted'), onDelete: (i) => takeOut(i, 'deleted') })
      );
      T.curId = it.id;
      T.atEnd = false;
    } else {
      node = finishPanel();
      T.curId = null;
      T.atEnd = true;
    }
    if (dir) node.classList.add(dir > 0 ? 'in-next' : 'in-prev');
    T.vp.textContent = '';
    T.vp.append(node);
    T.prev.disabled = T.idx === 0;
    T.next.disabled = T.idx >= n;
    T.next.title = T.idx === n - 1 ? '看完这批(→)' : '下一条(→)';
    updateProgress();
    // 页面如果滚下去了(上一张很长),翻页后拉回到进度条,从新这张的开头看起
    const top = T.progress.getBoundingClientRect().top;
    if (top < 60) window.scrollTo(0, window.scrollY + top - 72);
  }

  /** 翻页:delta=1 下一条(离开的这条算回顾过了),-1 上一条(不取消已回顾) */
  function go(delta) {
    const st = S.state;
    if (!st || S.tab !== 'today' || !T.vp) return;
    const n = st.items.length;
    const to = clamp(T.idx + delta, 0, n);
    if (to === T.idx) return;
    if (delta > 0) markReviewed(st.items[T.idx]);
    T.idx = to;
    paintSlide(delta);
  }

  /** 不再回顾 / 删除:这一条从今天拿掉,下一条顶上来;提示条里可以撤销 */
  async function takeOut(item, field) {
    const st = S.state;
    const idx = st.items.findIndex((i) => i.id === item.id);
    if (idx === -1) return;
    const call = (on) => (field === 'muted' ? rpc('mute', { id: item.id, muted: on }) : rpc('del', { id: item.id, deleted: on }));
    try {
      await call(true);
    } catch (e) {
      toast('没能保存:' + e.message);
      return;
    }
    st.items.splice(idx, 1);
    st.plan.ids = st.plan.ids.filter((x) => x !== item.id);
    st.plan.target = Math.max(0, st.plan.target - 1);
    delete st.plan.done[item.id];
    st.counts.eligible--;
    st.counts[field === 'muted' ? 'muted' : 'deleted']++;
    if (!st.items.length) {
      T.curId = null;
      T.atEnd = false;
      renderToday();
    } else {
      T.idx = Math.min(idx, st.items.length);
      paintSlide(1);
    }
    toast(field === 'muted' ? '已设为「不再回顾」' : '已删除(X 上的书签没动)', {
      label: '撤销',
      fn: async () => {
        try {
          await call(false);
          T.focus = item.id;
          await refresh();
        } catch (e) {
          toast('没能撤销:' + e.message);
        }
      },
    });
  }

  async function moreItems() {
    try {
      const n0 = S.state.items.length;
      const r = await rpc('more', { n: 4 });
      if (!r.added) {
        toast('书签池里没有更多可抽的了');
        return;
      }
      await loadState(true);
      T.focus = S.state.items[n0] ? S.state.items[n0].id : null; // 直接翻到新抽的第一条
      renderToday();
      window.scrollTo(0, 0);
    } catch (e) {
      toast('没能再抽:' + e.message);
    }
  }

  async function reroll() {
    if (!confirm('重新抽取今天的书签?\n当前这批会被换掉,已回顾的标记也会清空。')) return;
    try {
      await rpc('reroll');
      await loadState(true);
      T.curId = null;
      T.atEnd = false;
      T.focus = null;
      renderToday();
      window.scrollTo(0, 0);
    } catch (e) {
      toast('没能重新抽取:' + e.message);
    }
  }

  /* 拖动 / 划动翻页:横着拖超过一小段就翻,竖着拖照常滚动页面(触屏靠 CSS 的 touch-action: pan-y) */
  const selectableContent = '.card .text, .card .reply, .card .qt, .card .lc-title, .card .lc-desc';

  function attachGestures(vp) {
    let down = null;
    const slide = () => vp.firstElementChild;
    vp.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest(selectableContent) || e.target.closest('a, button, video, input, select, textarea, label')) return;
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, drag: false };
    });
    vp.addEventListener('pointermove', (e) => {
      if (!down || e.pointerId !== down.id) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!down.drag) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          down.drag = true;
          try {
            vp.setPointerCapture(e.pointerId);
          } catch (_) {}
          vp.classList.add('dragging');
          const sel = window.getSelection && window.getSelection();
          if (sel) sel.removeAllRanges();
        } else if (Math.abs(dy) > 10) {
          down = null; // 竖着拖:交给页面滚动
          return;
        } else {
          return;
        }
      }
      down.dx = dx;
      const n = S.state.items.length;
      const blocked = (dx > 0 && T.idx === 0) || (dx < 0 && T.idx >= n); // 到头了:拖不动,只给一点弹性
      const shown = blocked ? dx * 0.25 : dx;
      const s = slide();
      if (s) {
        s.style.transform = 'translateX(' + shown + 'px)';
        s.style.opacity = String(1 - Math.min(0.35, Math.abs(shown) / 600));
      }
      e.preventDefault();
    });
    const finish = (e) => {
      if (!down || e.pointerId !== down.id) return;
      const d = down;
      down = null;
      vp.classList.remove('dragging');
      try {
        vp.releasePointerCapture(e.pointerId);
      } catch (_) {}
      if (!d.drag) return;
      const v = d.dx / Math.max(1, performance.now() - d.t); // 速度 px/ms:快速一甩也算
      const dir = d.dx < -80 || (d.dx < -30 && v < -0.5) ? 1 : d.dx > 80 || (d.dx > 30 && v > 0.5) ? -1 : 0;
      const n = S.state.items.length;
      if (dir !== 0 && !((dir < 0 && T.idx === 0) || (dir > 0 && T.idx >= n))) {
        go(dir);
        return;
      }
      const s = slide();
      if (s) {
        s.style.transition = 'transform 0.18s ease, opacity 0.18s ease';
        s.style.transform = '';
        s.style.opacity = '';
        setTimeout(() => {
          s.style.transition = '';
        }, 220);
      }
    };
    vp.addEventListener('pointerup', finish);
    vp.addEventListener('pointercancel', finish);
  }

  /* 键盘 ← → 和触控板左右滑动(整个页面生命周期只装一次) */
  let wheelAcc = 0;
  let wheelReset = 0;
  let wheelLockUntil = 0;
  document.addEventListener('keydown', (e) => {
    if (S.tab !== 'today' || !T.vp || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const el = e.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|VIDEO|AUDIO)$/.test(el.tagName))) return;
    e.preventDefault();
    go(e.key === 'ArrowRight' ? 1 : -1);
  });
  document.addEventListener(
    'wheel',
    (e) => {
      if (S.tab !== 'today' || !T.vp) return;
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // 竖着滚:照常滚动页面
      e.preventDefault(); // 同时挡住浏览器自己的「两指左右滑 = 前进后退」
      if (e.target.closest(selectableContent) || !window.getSelection().isCollapsed) {
        wheelAcc = 0;
        return;
      }
      const now = Date.now();
      if (now < wheelLockUntil) {
        wheelLockUntil = Math.max(wheelLockUntil, now + 140); // 触控板松手后还有一串惯性事件,等它停了再接受下一次
        return;
      }
      wheelAcc += e.deltaX;
      clearTimeout(wheelReset);
      wheelReset = setTimeout(() => {
        wheelAcc = 0;
      }, 180);
      if (Math.abs(wheelAcc) >= 70) {
        const dir = wheelAcc > 0 ? 1 : -1;
        wheelAcc = 0;
        wheelLockUntil = now + 550;
        go(dir);
      }
    },
    { passive: false }
  );

  function renderToday() {
    const root = $('#view-today');
    root.textContent = '';
    T.vp = T.prev = T.next = T.bar = T.num = T.sub = T.progress = null;
    const st = S.state;
    if (!st) {
      root.append(h('div', { class: 'empty', text: '正在加载…' }));
      return;
    }
    if (T.day !== st.today) {
      // 新的一天:不沿用昨天停在哪一张
      T.day = st.today;
      T.curId = null;
      T.atEnd = false;
      T.focus = null;
    }
    const items = st.items;
    const subEl = h('div', { class: 'sub', text: todaySub(items.length) });
    root.append(h('div', { class: 'page-head' }, h('h1', { text: '今日回顾' }), subEl));
    if (st.counts.total > 0 && st.counts.stale > 0 && !T.hideResync) root.append(resyncNotice(st.counts.stale));

    if (st.counts.total === 0) {
      root.append(onboarding());
      return;
    }
    if (st.counts.eligible === 0) {
      root.append(emptyBox('回顾池是空的', '所有书签都被静音、已移出或已删除。可以到「全部书签」里恢复。'));
      return;
    }
    if (!items.length) {
      root.append(emptyBox('今天这批处理完了', '想继续的话,再抽几条。'), moreRow(st));
      return;
    }

    // 起始位置:优先回到刚才那张;没有就从第一条还没回顾的开始(全都回顾过了就是「看完了」页)
    const firstUndone = items.findIndex((i) => !st.plan.done[i.id]);
    let idx = firstUndone === -1 ? items.length : firstUndone;
    if (T.focus) {
      const k = items.findIndex((i) => i.id === T.focus);
      if (k !== -1) idx = k;
      T.focus = null;
    } else if (T.curId) {
      const k = items.findIndex((i) => i.id === T.curId);
      if (k !== -1) idx = k;
    } else if (T.atEnd) {
      idx = items.length;
    }
    T.idx = idx;

    const progress = h('div', { class: 'progress' }, h('div', { class: 'bar' }, h('i')), h('div', { class: 'num' }));
    T.progress = progress;
    T.sub = subEl;
    T.bar = $('i', progress);
    T.num = $('.num', progress);
    const navBtn = (dir) =>
      h(
        'button',
        {
          class: 'navbtn ' + dir,
          type: 'button',
          'aria-label': dir === 'prev' ? '上一条' : '下一条',
          title: dir === 'prev' ? '上一条(←)' : '下一条(→)',
          onclick: () => go(dir === 'prev' ? -1 : 1),
        },
        icon(dir === 'prev' ? 'chevL' : 'chevR')
      );
    T.prev = navBtn('prev');
    T.next = navBtn('next');
    T.vp = h('div', { class: 'viewport' });
    const stage = h('div', { class: 'stage' }, h('div', { class: 'nav' }, T.prev), T.vp, h('div', { class: 'nav' }, T.next));
    root.append(progress, stage, h('div', { class: 'keys-hint', text: '← → 方向键、左右划动、点两边的箭头都能翻页 · 翻过去的就算回顾过了' }), moreRow(st));
    attachGestures(T.vp);
    paintSlide(0);
  }

  /* ================= 全部书签 ================= */
  const FILTERS = [
    ['active', '在回顾池'],
    ['liked', '点赞过的'],
    ['muted', '已静音'],
    ['removed', '已移出'],
    ['deleted', '已删除'],
    ['all', '全部'],
  ];

  function buildLibraryShell() {
    const root = $('#view-library');
    const search = h('input', { class: 'search', type: 'search', placeholder: '搜索书签内容、作者…', 'aria-label': '搜索书签' });
    const sel = h('select', { class: 'sel', 'aria-label': '筛选' });
    for (const [v, label] of FILTERS) sel.append(h('option', { value: v, text: label }));
    let timer = 0;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        S.lib.q = search.value.trim();
        loadLibrary(true).catch(showFatal);
      }, 220);
    });
    sel.addEventListener('change', () => {
      S.lib.filter = sel.value;
      loadLibrary(true).catch(showFatal);
    });
    root.append(
      h('div', { class: 'page-head' }, h('h1', { text: '全部书签' }), h('div', { class: 'sub', text: '搜索、查看,或把不想再看到的恢复回来。' })),
      h('div', { class: 'tools' }, search, sel),
      h('div', { class: 'count-line' }),
      h('div', { class: 'list' }),
      h('div', { class: 'more' })
    );
  }

  let libSeq = 0;
  async function loadLibrary(reset) {
    const L = S.lib;
    const seq = ++libSeq; // 连着换筛选/搜索时会有几个请求同时在路上:只认最新发出的那一个,旧的结果丢掉,免得拼到一起
    if (reset) L.items = [];
    const r = await rpc('list', { q: L.q, filter: L.filter, offset: L.items.length, limit: 30 });
    if (seq !== libSeq) return;
    L.total = r.total;
    L.counts = r.counts;
    L.items = L.items.concat(r.items);
    renderLibrary();
  }

  function renderLibrary() {
    const L = S.lib;
    const root = $('#view-library');
    const sel = $('.sel', root);
    const c = L.counts || { total: 0, eligible: 0, muted: 0, removed: 0, deleted: 0, liked: 0 };
    const nums = { active: c.eligible, liked: c.liked, muted: c.muted, removed: c.removed, deleted: c.deleted, all: c.total - c.deleted };
    for (const o of sel.options) o.textContent = FILTERS.find((f) => f[0] === o.value)[1] + '(' + nums[o.value] + ')';
    sel.value = L.filter;
    $('.count-line', root).textContent = L.q ? '找到 ' + L.total + ' 条' : '共 ' + L.total + ' 条';

    const list = $('.list', root);
    list.textContent = '';
    if (!L.items.length) {
      list.append(h('div', { class: 'empty' }, h('p', { text: L.q ? '没有符合的书签。' : '这里还没有书签。' })));
    }
    for (const it of L.items) {
      list.append(
        renderCard(it, {
          mode: 'library',
          lazy: true,
          onLike: async (item, card) => {
            await toggleLike(item, card);
            if (L.filter === 'liked' && !item.liked) setTimeout(() => loadLibrary(true).catch(showFatal), 300); // 取消赞的,从「点赞过的」里消失
          },
          onMute: async (item) => {
            try {
              await rpc('mute', { id: item.id, muted: true });
              await loadLibrary(true);
              toast('已设为「不再回顾」');
            } catch (e) {
              toast('没能保存:' + e.message);
            }
          },
          onUnmute: async (item) => {
            try {
              await rpc('mute', { id: item.id, muted: false });
              await loadLibrary(true);
              toast('已恢复,会重新进入回顾池');
            } catch (e) {
              toast('没能保存:' + e.message);
            }
          },
          onDelete: async (item) => {
            try {
              await rpc('del', { id: item.id, deleted: true });
              await loadLibrary(true);
              toast('已删除(X 上的书签没动)', {
                label: '撤销',
                fn: async () => {
                  try {
                    await rpc('del', { id: item.id, deleted: false });
                    await loadLibrary(true);
                  } catch (e) {
                    toast('没能撤销:' + e.message);
                  }
                },
              });
            } catch (e) {
              toast('没能保存:' + e.message);
            }
          },
          onRestore: async (item) => {
            try {
              await rpc('del', { id: item.id, deleted: false });
              await loadLibrary(true);
              toast('已恢复');
            } catch (e) {
              toast('没能保存:' + e.message);
            }
          },
        })
      );
    }
    const more = $('.more', root);
    more.textContent = '';
    if (L.items.length < L.total) {
      more.append(h('button', { class: 'btn', type: 'button', text: '加载更多(还有 ' + (L.total - L.items.length) + ' 条)', onclick: () => loadLibrary(false).catch(showFatal) }));
    }
  }

  /* ================= 设置 ================= */
  async function saveSettings(patch) {
    const s = await rpc('settings', { patch });
    S.state.settings = s;
    toast('已保存');
    return s;
  }

  function switchRow(label, hint, checked, onChange, extra) {
    const input = h('input', { type: 'checkbox', 'aria-label': label });
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    return h(
      'div',
      { class: 'row' },
      h('div', { class: 'lab' }, h('b', { text: label }), h('small', { text: hint })),
      h('div', { class: 'ctl' }, extra || null, h('label', { class: 'switch' }, input, h('i')))
    );
  }

  function renderSettings() {
    const root = $('#view-settings');
    root.textContent = '';
    const st = S.state;
    if (!st) return;
    const s = st.settings;

    /* 每日条数 */
    const dailyCount = h(
      'select',
      { class: 'sel', 'aria-label': '每天回顾几条' },
      window.XBR_PLAN.DAILY_COUNTS.map((n) => h('option', { value: n, text: n + ' 条' }))
    );
    dailyCount.value = String(s.dailyCount);
    dailyCount.addEventListener('change', async () => {
      dailyCount.disabled = true;
      try {
        const saved = await saveSettings({ dailyCount: Number(dailyCount.value) });
        dailyCount.value = String(saved.dailyCount);
      } catch (e) {
        dailyCount.value = String(S.state.settings.dailyCount);
        toast('没能保存:' + e.message);
      } finally {
        dailyCount.disabled = false;
      }
    });

    /* 提醒 */
    const timeIn = h('input', { class: 'num-in', type: 'time', value: s.reminderTime, 'aria-label': '提醒时间' });
    timeIn.addEventListener('change', async () => {
      if (!timeIn.value) return;
      try {
        await saveSettings({ reminderTime: timeIn.value });
      } catch (e) {
        toast('没能保存:' + e.message);
      }
    });

    /* 同步信息 */
    const sync = st.sync || {};
    const lastTxt = sync.lastRunAt
      ? '上次同步:' + fmtClock(sync.lastRunAt) + '(读取 ' + (sync.lastTweets || 0) + ' 条,新增 ' + (sync.lastAdded || 0) + ' 条' + (sync.lastRemoved ? ',移出 ' + sync.lastRemoved + ' 条' : '') + ')'
      : '还没有同步过。';

    /* 数据 */
    const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files && fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      try {
        const r = await rpc('import', { data: JSON.parse(await f.text()) });
        toast('导入 ' + r.added + ' 条' + (r.existed ? ',已有 ' + r.existed + ' 条跳过' : '') + (r.bad ? ',' + r.bad + ' 条无法识别' : ''));
        await refresh();
      } catch (e) {
        toast('导入失败:' + e.message);
      }
    });

    const c = st.counts;
    root.append(
      h('div', { class: 'page-head' }, h('h1', { text: '设置' }), h('div', { class: 'sub', text: '书签池共 ' + c.total + ' 条(在回顾池 ' + c.eligible + ' · 已静音 ' + c.muted + ' · 已移出 ' + c.removed + ' · 已删除 ' + c.deleted + ')' })),

      h(
        'div',
        { class: 'panel' },
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'lab' }, h('b', { text: '每天回顾几条' }), h('small', { text: '新条数从明天起生效。今天想换一批，可在「今日回顾」点「重新抽取今天的」。' })),
          h('div', { class: 'ctl' }, dailyCount)
        ),
        switchRow('每日提醒', '到点弹一条系统通知,点开就是今天的回顾。', s.reminderEnabled, async (v) => {
          try {
            await saveSettings({ reminderEnabled: v });
          } catch (e) {
            toast('没能保存:' + e.message);
          }
        }, timeIn),
        switchRow('每天第一次打开浏览器时,自动打开今日回顾', '只在每天第一次启动浏览器时打开一次,不会反复打扰。', s.openOnStartup, async (v) => {
          try {
            await saveSettings({ openOnStartup: v });
          } catch (e) {
            toast('没能保存:' + e.message);
          }
        })
      ),

      h(
        'div',
        { class: 'panel' },
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'lab' }, h('b', { text: '同步 X 书签' }), h('small', { text: lastTxt + ' 平时在 X 上新点的书签会自动收进来;在手机上收藏的,点「增量同步」补上。「完整同步」会读完整个列表,并把你在 X 上已取消收藏的移出回顾池。' })),
          h('div', { class: 'ctl' }, h('button', { class: 'btn', type: 'button', text: '增量同步', onclick: () => startSync('incremental') }), h('button', { class: 'btn', type: 'button', text: '完整同步', onclick: () => startSync('full') }))
        )
      ),

      h(
        'div',
        { class: 'panel' },
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'lab' }, h('b', { text: '备份' }), h('small', { text: '导出成一个 JSON 文件,换电脑或重装时导入即可(回顾次数、点赞、静音、删除状态也会带上)。' })),
          h('div', { class: 'ctl' }, h('button', { class: 'btn', type: 'button', text: '导出备份', onclick: exportData }), h('button', { class: 'btn', type: 'button', text: '导入备份', onclick: () => fileIn.click() }), fileIn)
        ),
        c.removed
          ? h(
              'div',
              { class: 'row' },
              h('div', { class: 'lab' }, h('b', { text: '已移出的 ' + c.removed + ' 条' }), h('small', { text: '这些在 X 上已取消收藏(或同步时没读到),不再参与抽取。要是移出错了,可以全部放回来。' })),
              h('div', { class: 'ctl' }, h('button', { class: 'btn', type: 'button', text: '全部恢复', onclick: restoreRemoved }))
            )
          : null,
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'lab' }, h('b', { text: '清空本机数据' }), h('small', { text: '只删除这个扩展保存在本机的书签副本,不影响你在 X 上的书签。建议先导出备份。' })),
          h('div', { class: 'ctl' }, h('button', { class: 'btn btn-danger', type: 'button', text: '清空', onclick: clearAll }))
        )
      ),

      h(
        'div',
        { class: 'panel' },
        h('div', { class: 'row' }, h('div', { class: 'lab' }, h('b', { text: '隐私' }), h('small', { text: '扩展只读取你在浏览器里已登录的 X 页面自己加载的书签数据,不使用 X 的接口密钥,也不会把任何内容发到别的服务器。全部数据都存在这台电脑的浏览器里。' }))),
        h('div', { class: 'row' }, h('div', { class: 'lab' }, h('b', { text: '版本' }), h('small', { text: 'X 书签每日回顾 ' + chrome.runtime.getManifest().version })))
      )
    );
  }

  async function exportData() {
    try {
      const data = await rpc('export');
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: 'x-bookmark-review-' + dayKeyNow() + '.json' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('已导出 ' + data.items.length + ' 条');
    } catch (e) {
      toast('导出失败:' + e.message);
    }
  }

  async function restoreRemoved() {
    try {
      const r = await rpc('restoreRemoved');
      toast('已恢复 ' + r.restored + ' 条');
      await refresh();
    } catch (e) {
      toast('没能恢复:' + e.message);
    }
  }

  async function clearAll() {
    if (!confirm('清空本机上的全部书签数据?\n\n不影响你在 X 上的书签,之后可以重新同步回来,但回顾次数、静音状态会丢失。建议先导出备份。')) return;
    try {
      await rpc('clearAll');
      toast('已清空');
      await refresh();
    } catch (e) {
      toast('没能清空:' + e.message);
    }
  }

  /* ================= 同步 ================= */
  async function startSync(mode) {
    try {
      const r = await rpc('syncStart', { mode });
      if (!r.started) {
        toast(r.reason === 'running' ? '已经有一个同步在进行了,已切过去' : '没能开始同步');
        return;
      }
      setBanner('正在打开 X 书签页…', 'busy');
      $('#syncBtn').disabled = true;
    } catch (e) {
      toast('没能开始同步:' + e.message);
    }
  }

  const OUTCOME = {
    nologin: '没有读到书签。请先在这个浏览器里登录 X,再同步一次。',
    aborted: '同步被中断了(书签页被关掉了)。已读到的书签已经保存。',
    ratelimit: 'X 在限速,过一会儿再同步吧。已读到的书签已经保存。',
    http: 'X 拒绝了请求,请确认已登录后再试。',
    stalled: '等了很久 X 都没有返回新内容,先停在这里。已读到的书签已经保存。',
    stopped: '同步已停止。已读到的书签已经保存。',
  };

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || typeof m.type !== 'string') return; // 不回应任何消息:回应是后台的事
    if (m.type === 'sync:progress') {
      $('#syncBtn').disabled = true;
      setBanner(m.started ? '正在打开 X 书签页…' : '正在同步:已读取 ' + m.tweets + ' 条,新增 ' + m.added + ' 条', 'busy');
    } else if (m.type === 'sync:done') {
      $('#syncBtn').disabled = false;
      if (m.ok) {
        setBanner('✓ 同步完成:读取 ' + m.tweets + ' 条,新增 ' + m.added + ' 条' + (m.removed ? ',移出 ' + m.removed + ' 条已取消收藏的' : ''));
        setTimeout(() => {
          if (!$('#banner').classList.contains('busy')) setBanner('');
        }, 8000);
      } else {
        setBanner(OUTCOME[m.outcome] || '同步没有完成(' + m.outcome + ')。', 'warn');
      }
      refresh();
    }
  });

  /* ================= 页签 ================= */
  const TABS = ['today', 'library', 'settings'];
  const tabFromHash = () => {
    const t = location.hash.replace('#', '');
    return TABS.indexOf(t) !== -1 ? t : 'today';
  };

  async function switchTab(tab) {
    S.tab = tab;
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    TABS.forEach((t) => {
      $('#view-' + t).hidden = t !== tab;
    });
    try {
      if (tab === 'today') {
        await loadState(true);
        renderToday();
      } else if (tab === 'library') {
        if (!S.state) await loadState(false);
        await loadLibrary(true);
      } else {
        await loadState(false);
        renderSettings();
      }
    } catch (e) {
      showFatal(e);
    }
  }

  document.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => {
      const target = '#' + b.dataset.tab;
      if (location.hash === target) switchTab(b.dataset.tab);
      else location.hash = target;
    })
  );
  window.addEventListener('hashchange', () => switchTab(tabFromHash()));
  $('#syncBtn').addEventListener('click', () => startSync('incremental'));

  // 标签页开了一夜:切回来时发现已经隔天了,就换成新一天的计划
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.state && S.state.today !== dayKeyNow()) refresh();
  });

  buildLibraryShell();
  switchTab(tabFromHash());
})();
