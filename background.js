/* 后台(service worker)。职责:
 *  - 书签入库;每日计划(抽取、已回顾、不再回顾)
 *  - 同步任务调度(开/复用 X 书签页,收尾时清理已取消的书签)
 *  - 图标角标、每日提醒、启动时自动打开
 * 所有会改数据的操作都排进同一条队列(withLock),不会互相踩。 */
importScripts('lib/parse.js', 'lib/plan.js', 'lib/db.js');

const PARSE = self.XBR_PARSE;
const P = self.XBR_PLAN;
const DB = self.XBR_DB;
const PV = PARSE.PV; // 当前解析版本;条目上的 pv 比它低,说明是旧版读的(缺卡片标题),要重新同步一次

const APP_URL = chrome.runtime.getURL('app.html');
const BOOKMARKS_URL = 'https://x.com/i/bookmarks';
const DEFAULTS = {
  reminderEnabled: true,
  reminderTime: '09:00',
  openOnStartup: false,
};

/* ---------- 串行队列 ---------- */
let chain = Promise.resolve();
function withLock(fn) {
  const r = chain.then(() => fn());
  chain = r.catch(() => {});
  return r;
}

/* ---------- 小工具 ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
function clampInt(v, lo, hi, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}
const isExtPage = (s) => !!(s && s.url && s.url.startsWith(chrome.runtime.getURL('')));
const isXPage = (s) => !!(s && s.tab && /^https:\/\/(x|twitter)\.com\//.test(s.url || ''));
function broadcast(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
}

/* ---------- 设置 ---------- */
async function getSettings() {
  const { countMin, countMax, ...settings } = (await DB.kvGet('settings')) || {};
  return Object.assign({}, DEFAULTS, settings, {
    dailyCount: P.planTarget({ dailyCount: settings.dailyCount, countMin, countMax }),
  });
}

function cleanSettings(p) {
  const out = {};
  if (P.DAILY_COUNTS.includes(p.dailyCount)) out.dailyCount = p.dailyCount;
  if ('reminderEnabled' in p) out.reminderEnabled = !!p.reminderEnabled;
  if ('reminderTime' in p && /^\d{1,2}:\d{2}$/.test(String(p.reminderTime))) {
    const t = P.parseHHMM(p.reminderTime);
    out.reminderTime = pad2(t.h) + ':' + pad2(t.m);
  }
  if ('openOnStartup' in p) out.openOnStartup = !!p.openOnStartup;
  return out;
}

async function doSettings(patch) {
  const next = Object.assign(await getSettings(), cleanSettings(patch));
  await DB.kvSet('settings', next);
  await scheduleAlarms(true);
  return next;
}

/* ---------- 同步任务登记(放在 session 存储里,后台被回收也不丢) ---------- */
let memJobs = {};
async function getJobs() {
  try {
    const r = await chrome.storage.session.get('jobs');
    return r.jobs || {};
  } catch (_) {
    return memJobs;
  }
}
async function setJobs(j) {
  memJobs = j;
  try {
    await chrome.storage.session.set({ jobs: j });
  } catch (_) {}
}
async function anyJobActive() {
  const jobs = await getJobs();
  return Object.keys(jobs).some((k) => jobs[k].status === 'running' || jobs[k].status === 'pending');
}

/* ---------- 每日计划 ---------- */
const remainingOf = (plan) => plan.ids.filter((id) => !plan.done[id]).length;

/**
 * 取(必要时新建/补齐)今天的计划。
 * opts.view   这次是给用户看的:第一次被看到时,才把这批条目的"出现次数"+1
 * opts.reroll 丢掉今天这批重抽(尽量避开刚才那批;撤销已计的次数)
 */
async function doPlan(opts) {
  opts = opts || {};
  const settings = await getSettings();
  const today = P.dayKey();
  let plan = await DB.kvGet('plan');
  let planChanged = false;

  const local = new Map(); // id → 条目(本次调用内共用一份副本,改了就记进 dirty)
  const dirty = new Map();
  let all = null;
  const loadAll = async () => {
    if (!all) {
      const rows = await DB.getAll('items');
      all = rows.map((r) => local.get(r.id) || (local.set(r.id, r), r));
    }
    return all;
  };
  const loadIds = async (ids) => {
    const need = ids.filter((id) => !local.has(id));
    if (!need.length) return;
    const got = await DB.getMany('items', need);
    got.forEach((it, i) => {
      if (it) local.set(need[i], it);
    });
  };
  const touch = (it) => dirty.set(it.id, it);
  const bump = (ids) => {
    for (const id of ids) {
      const it = local.get(id);
      if (it) {
        if (it.reviewCount === undefined) Object.assign(it, P.reviewHistory(it));
        it.shownCount = (it.shownCount | 0) + 1;
        it.lastShownDay = today;
        touch(it);
      }
    }
  };

  if (!plan || plan.day !== today || opts.reroll) {
    const rows = await loadAll();
    let avoid;
    if (plan && plan.day === today && opts.reroll) {
      avoid = new Set(plan.ids);
      if (plan.seen) {
        for (const id of plan.ids) {
          const it = local.get(id);
          if (it && it.shownCount > 0) {
            if (it.reviewCount === undefined) Object.assign(it, P.reviewHistory(it));
            it.shownCount--;
            touch(it);
          }
        }
      }
    }
    plan = P.newPlan(rows, settings, today, { avoid });
    planChanged = true;
  } else {
    await loadIds(plan.ids);
    if (P.dropIneligible(plan, local).length) planChanged = true;
    if (plan.ids.length < plan.target) {
      const rows = await loadAll();
      const extra = P.topUpPlan(plan, rows);
      if (extra.length) {
        planChanged = true;
        if (plan.seen) bump(extra);
      }
    }
  }

  await loadIds(plan.ids);
  if (opts.view && !plan.seen) {
    bump(plan.ids);
    plan.seen = true;
    planChanged = true;
  }
  if (planChanged) await DB.kvSet('plan', plan);
  if (dirty.size) await DB.putMany('items', Array.from(dirty.values()));
  const items = plan.ids.map((id) => local.get(id)).filter(Boolean);
  return { plan, items, settings, all };
}

/** 互斥分类:已删除 > 已移出 > 已静音 > 在回顾池;liked 另算(不含已删除的);stale = 还没用新版解析读过的 */
function countItems(all) {
  let eligible = 0;
  let muted = 0;
  let removed = 0;
  let deleted = 0;
  let liked = 0;
  let stale = 0;
  for (const i of all) {
    if (i.deleted) {
      deleted++;
      continue;
    }
    if (i.liked) liked++;
    if (i.removed) {
      removed++;
      continue;
    }
    if (i.muted) muted++;
    else eligible++;
    if ((i.pv | 0) < PV) stale++;
  }
  return { total: all.length, eligible, muted, removed, deleted, liked, stale };
}

async function doState(view) {
  const r = await doPlan({ view });
  const all = r.all || (await DB.getAll('items'));
  const sync = (await DB.kvGet('sync')) || {};
  await updateBadge();
  return {
    today: P.dayKey(),
    plan: { day: r.plan.day, target: r.plan.target, seen: r.plan.seen, done: r.plan.done, ids: r.plan.ids },
    items: r.items,
    settings: r.settings,
    counts: countItems(all),
    sync: Object.assign({}, sync, { running: await anyJobActive() }),
  };
}

async function doDone(id, done) {
  const plan = await DB.kvGet('plan');
  const today = P.dayKey();
  if (!plan || plan.day !== today || !plan.ids.includes(id)) return { ok: false };
  if (done && !plan.done[id]) {
    const item = await DB.get('items', id);
    if (!item) return { ok: false };
    const now = Date.now();
    const history = P.reviewHistory(item);
    const reviewedToday = item.reviewCount > 0 && history.lastReviewedAt && P.dayKey(new Date(history.lastReviewedAt)) === today;
    item.reviewCount = history.reviewCount + (reviewedToday ? 0 : 1);
    item.lastReviewedAt = now;
    plan.done[id] = now;
    await DB.run(['items', 'kv'], 'readwrite', (tx) => {
      tx.objectStore('items').put(item);
      tx.objectStore('kv').put(plan, 'plan');
    });
  } else if (!done && plan.done[id]) {
    delete plan.done[id];
    await DB.kvSet('plan', plan);
  }
  await updateBadge();
  return { ok: true, remaining: remainingOf(plan) };
}

async function dropFromPlan(id) {
  const plan = await DB.kvGet('plan');
  if (plan && plan.day === P.dayKey() && plan.ids.indexOf(id) !== -1) {
    plan.ids = plan.ids.filter((x) => x !== id);
    plan.target = Math.max(0, plan.target - 1);
    delete plan.done[id];
    await DB.kvSet('plan', plan);
  }
}

/**
 * 把一条从今天的计划里拿掉 / 放回原处。
 * field: 'muted'(不再回顾:还留在「全部书签」里)或 'deleted'(删除:只删本机这份,留一条记录,
 * 否则下次同步又会把它从 X 书签里收回来;X 上的书签不受影响,可在「已删除」里恢复)。
 */
async function setOut(id, field, on) {
  const it = await DB.get('items', id);
  if (!it) return { ok: false };
  const today = P.dayKey();
  if (on) {
    const plan = await DB.kvGet('plan');
    const idx = plan && plan.day === today ? plan.ids.indexOf(id) : -1;
    it[field] = true;
    if (field === 'deleted') it.deletedAt = Date.now();
    // 记下它在今天计划里的位置,方便"撤销"时放回原处
    if (idx !== -1) it.planBack = { day: today, index: idx, doneAt: plan.done[id] || 0 };
    else delete it.planBack;
    delete it.mutedFromPlan; // 0.1.0 留下的旧字段名
    await DB.put('items', it);
    if (idx !== -1) await dropFromPlan(id);
  } else {
    const back = it.planBack || it.mutedFromPlan;
    it[field] = false;
    if (field === 'deleted') delete it.deletedAt;
    delete it.planBack;
    delete it.mutedFromPlan;
    await DB.put('items', it);
    if (back && back.day === today && P.isEligible(it)) {
      const plan = await DB.kvGet('plan');
      if (plan && plan.day === today && plan.ids.indexOf(id) === -1) {
        plan.ids.splice(Math.min(back.index, plan.ids.length), 0, id);
        plan.target += 1;
        if (back.doneAt || back.wasDone) plan.done[id] = back.doneAt || Date.now();
        await DB.kvSet('plan', plan);
      }
    }
  }
  await updateBadge();
  return { ok: true };
}

/** 点赞:只记在本机,不会去 X 上点赞 */
async function doLike(id, liked) {
  const it = await DB.get('items', id);
  if (!it) return { ok: false };
  it.liked = !!liked;
  if (it.liked) it.likedAt = Date.now();
  else delete it.likedAt;
  await DB.put('items', it);
  return { ok: true, liked: it.liked };
}

async function doUnbookmark(m) {
  const id = String(m.id || '');
  const it = await DB.get('items', id);
  if (!it || it.removed) return { ok: true, changed: false };
  it.removed = true;
  it.removedAt = Date.now();
  await DB.put('items', it);
  await dropFromPlan(id);
  await updateBadge();
  return { ok: true, changed: true };
}

async function doMore(n) {
  n = clampInt(n, 1, 50, 4);
  const r = await doPlan({});
  const rows = r.all || (await DB.getAll('items'));
  const extra = P.pickItems(rows, n, { exclude: new Set(r.plan.ids) });
  if (!extra.length) return { added: 0 };
  const plan = r.plan;
  const byId = new Map(rows.map((i) => [i.id, i]));
  const added = extra.map((id) => byId.get(id));
  if (!plan.reviewIds) plan.reviewIds = rows.filter((it) => plan.ids.includes(it.id) && P.reviewHistory(it).reviewCount > 0).map((it) => it.id);
  plan.reviewIds.push(...added.filter((it) => P.reviewHistory(it).reviewCount > 0).map((it) => it.id));
  plan.ids.push(...extra);
  plan.target += extra.length;
  if (plan.seen) {
    for (const it of added) {
      if (it.reviewCount === undefined) Object.assign(it, P.reviewHistory(it));
      it.shownCount = (it.shownCount | 0) + 1;
      it.lastShownDay = P.dayKey();
    }
    await DB.putMany('items', added);
  }
  await DB.kvSet('plan', plan);
  await updateBadge();
  return { added: extra.length };
}

async function doList(m) {
  const q = String(m.q || '').trim().toLowerCase();
  const filter = m.filter || 'active';
  const offset = clampInt(m.offset, 0, 1e7, 0);
  const limit = clampInt(m.limit, 1, 200, 40);
  let rows = await DB.getAll('items');
  const counts = countItems(rows);
  if (filter === 'active') rows = rows.filter(P.isEligible);
  else if (filter === 'liked') rows = rows.filter((i) => i.liked && !i.deleted);
  else if (filter === 'muted') rows = rows.filter((i) => i.muted && !i.removed && !i.deleted);
  else if (filter === 'removed') rows = rows.filter((i) => i.removed && !i.deleted);
  else if (filter === 'deleted') rows = rows.filter((i) => i.deleted);
  else rows = rows.filter((i) => !i.deleted); // 全部:不含已删除的
  if (q) {
    rows = rows.filter((i) =>
      (i.text + ' ' + i.name + ' @' + i.handle + ' ' + ((i.quoted && i.quoted.text) || '') + ' ' + (i.card ? i.card.title + ' ' + i.card.desc : ''))
        .toLowerCase()
        .includes(q)
    );
  }
  const stamp = (i) => (filter === 'liked' ? i.likedAt : filter === 'deleted' ? i.deletedAt : 0) || i.bookmarkedAt || i.capturedAt || 0;
  rows.sort((a, b) => stamp(b) - stamp(a));
  return { total: rows.length, counts, items: rows.slice(offset, offset + limit) };
}

/* ---------- 角标 ---------- */
async function updateBadge() {
  try {
    const plan = await DB.kvGet('plan');
    const n = plan && plan.day === P.dayKey() ? remainingOf(plan) : 0;
    await chrome.action.setBadgeBackgroundColor({ color: '#2fa866' });
    await chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
    await chrome.action.setTitle({ title: n > 0 ? 'X 书签每日回顾 · 今天还有 ' + n + ' 条没回顾' : 'X 书签每日回顾' });
  } catch (_) {}
}

let refreshTimer = 0;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    withLock(async () => {
      if (await anyJobActive()) return; // 同步中先别补计划:等整库读完再从全库里抽,而不是只从前几页里抽
      await doPlan({});
      await updateBadge();
    }).catch(() => {});
  }, 1200);
}

/* ---------- 入库 ---------- */
const CONTENT_FIELDS = ['handle', 'name', 'avatar', 'verified', 'text', 'media', 'card', 'quoted', 'replyTo', 'lang', 'createdAt', 'url'];

function newItem(inc, source, now) {
  const bm =
    source === 'bookmarks' ? PARSE.plausibleMs(PARSE.snowflakeMs(inc.sortIndex)) : source === 'live' ? now : null;
  return Object.assign({}, inc, {
    source,
    capturedAt: now,
    bookmarkedAt: bm || null,
    lastSeenAt: now,
    shownCount: 0,
    reviewCount: 0,
    muted: false,
    removed: false,
    pv: PV,
  });
}

function mergeItem(prev, inc, source, now) {
  const item = Object.assign({}, prev);
  let changed = false;
  item.lastSeenAt = now;
  if (item.removed) {
    item.removed = false; // 又出现在书签里了
    delete item.removedAt;
    changed = true;
  }
  // 读页面文字得到的内容质量低(长推文会被截断),不覆盖已有的完整数据
  const better = !(source === 'dom' && prev.source !== 'dom');
  if (better) {
    for (const f of CONTENT_FIELDS) {
      if (f === 'text' && source === 'dom' && String(inc.text).length < String(prev.text || '').length) continue;
      if (JSON.stringify(item[f]) !== JSON.stringify(inc[f])) {
        item[f] = inc[f];
        changed = true;
      }
    }
    item.source = source;
    if ((item.pv | 0) !== PV) {
      item.pv = PV; // 这条已经用新版解析重读过了
      changed = true;
    }
  }
  if (source === 'bookmarks' && inc.sortIndex) {
    item.sortIndex = inc.sortIndex;
    const bm = PARSE.plausibleMs(PARSE.snowflakeMs(inc.sortIndex));
    if (bm && bm !== item.bookmarkedAt) {
      item.bookmarkedAt = bm;
      changed = true;
    }
  } else if (source === 'live') {
    item.bookmarkedAt = now; // 刚刚重新收藏
  }
  return { item, changed };
}

async function doIngest(items, source) {
  if (!items.length) return { added: 0, updated: 0, total: await DB.count('items') };
  const now = Date.now();
  const prevs = await DB.getMany(
    'items',
    items.map((i) => i.id)
  );
  const out = [];
  let added = 0;
  let updated = 0;
  items.forEach((inc, i) => {
    const prev = prevs[i];
    if (!prev) {
      added++;
      out.push(newItem(inc, source, now));
    } else {
      const m = mergeItem(prev, inc, source, now);
      if (m.changed) updated++;
      out.push(m.item);
    }
  });
  await DB.putMany('items', out);
  return { added, updated, total: await DB.count('items') };
}

async function doIngestMsg(m) {
  const source = m.source === 'live' || m.source === 'dom' ? m.source : 'bookmarks';
  const raw = Array.isArray(m.items) ? m.items.slice(0, 500) : [];
  const items = raw.map(PARSE.sanitizeItem).filter(Boolean);
  const res = await withLock(() => doIngest(items, source));
  if (res.added) refreshSoon();
  return res;
}

/** 完整同步读到列表尽头后:本轮没见到的 = 已在 X 上取消收藏,移出回顾池(软移除,可恢复) */
async function doReconcile(syncFrom) {
  const all = await DB.getAll('items');
  const active = all.filter((i) => !i.removed);
  const missing = active.filter((i) => (i.lastSeenAt || 0) < syncFrom);
  const seen = active.length - missing.length;
  // 保险:这次读到的不到原来的 40%(且库不算小),多半是读取不全,不动
  if (active.length >= 20 && seen < active.length * 0.4) return { removed: 0, skipped: true };
  const now = Date.now();
  for (const it of missing) {
    it.removed = true;
    it.removedAt = now;
  }
  await DB.putMany('items', missing);
  return { removed: missing.length, skipped: false };
}

/* ---------- 同步调度 ---------- */
async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab && tab.windowId != null) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (_) {}
  }
  return tab;
}

async function doSyncStart(m, sender) {
  const mode = m.mode === 'full' ? 'full' : 'incremental';
  const jobs = await getJobs();
  // 已经有任务在跑 → 切过去,不重复开
  for (const key of Object.keys(jobs)) {
    const j = jobs[key];
    if (j.status !== 'running' && j.status !== 'pending') {
      delete jobs[key];
      continue;
    }
    try {
      await chrome.tabs.get(Number(key));
      await focusTab(Number(key));
      await setJobs(jobs);
      return { started: false, reason: 'running' };
    } catch (_) {
      delete jobs[key]; // 标签页已经没了
    }
  }

  const openerTabId = isExtPage(sender) && sender.tab ? sender.tab.id : undefined;
  let tabId = null;
  if (isXPage(sender) && /^https:\/\/(x|twitter)\.com\/i\/bookmarks/.test(sender.url)) tabId = sender.tab.id;
  if (tabId == null) {
    const found = await chrome.tabs.query({ url: ['https://x.com/i/bookmarks*', 'https://twitter.com/i/bookmarks*'] });
    if (found.length) tabId = found[0].id;
  }
  let createdByUs = false;
  if (tabId == null) {
    // 先开空白页、登记任务、再跳转:保证页面里的脚本一启动就能查到任务
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    tabId = tab.id;
    createdByUs = true;
  }
  jobs[tabId] = { mode, status: 'pending', createdByUs, openerTabId, startedAt: Date.now() };
  await setJobs(jobs);
  const tab = await chrome.tabs.update(tabId, { url: BOOKMARKS_URL, active: true });
  if (tab && tab.windowId != null) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (_) {}
  }
  broadcast({ type: 'sync:progress', started: true, tweets: 0, added: 0 });
  return { started: true, tabId, createdByUs };
}

async function doHello(m, sender) {
  const tabId = sender.tab.id;
  const jobs = await getJobs();
  const j = jobs[tabId];
  if (!j || j.status !== 'pending') return { job: null };
  if (!/^\/i\/bookmarks/.test(String(m.path || ''))) {
    // 被带去了登录页之类的地方
    delete jobs[tabId];
    await setJobs(jobs);
    broadcast({ type: 'sync:done', ok: false, outcome: 'nologin', tweets: 0, added: 0, removed: 0, mode: j.mode });
    return { job: { blocked: 'login', mode: j.mode } };
  }
  j.status = 'running';
  await setJobs(jobs);
  return { job: { mode: j.mode } };
}

async function doJobDone(m, sender) {
  const tabId = sender.tab ? sender.tab.id : null;
  const jobs = await getJobs();
  const j = tabId != null ? jobs[tabId] : null;
  const now = Date.now();
  const outcome = String(m.outcome || '');
  const ok = outcome === 'end' || outcome === 'caughtUp';
  const mode = m.mode === 'full' ? 'full' : 'incremental';
  const tweets = clampInt(m.tweets, 0, 1e7, 0);
  const added = clampInt(m.added, 0, 1e7, 0);

  let removed = 0;
  let note = '';
  // 只有"网络数据读到尽头"才有资格清理;读页面文字的"到头"不可靠
  if (mode === 'full' && outcome === 'end' && !m.usedDom && tweets > 0) {
    const rr = await doReconcile(Number(m.syncFrom) || 0);
    removed = rr.removed;
    if (rr.skipped) note = 'reconcile-skipped';
  }

  const sync = (await DB.kvGet('sync')) || {};
  Object.assign(sync, { lastRunAt: now, lastOutcome: outcome, lastMode: mode, lastTweets: tweets, lastAdded: added, lastRemoved: removed, lastNote: note });
  if (ok) sync.lastOkAt = now;
  if (mode === 'full' && outcome === 'end' && !m.usedDom) sync.lastFullAt = now;
  await DB.kvSet('sync', sync);

  if (tabId != null && jobs[tabId]) {
    delete jobs[tabId];
    await setJobs(jobs);
  }
  await doPlan({}); // 整库读完了:补齐今天的计划(从全库里抽)
  await updateBadge();
  broadcast({ type: 'sync:done', ok, outcome, tweets, added, removed, mode, http: m.http | 0 });

  // 自己开的标签页:成功后过几秒关掉,回到发起同步的页面
  if (j && j.createdByUs && ok && tabId != null) {
    setTimeout(async () => {
      try {
        await chrome.tabs.remove(tabId);
      } catch (_) {}
      if (j.openerTabId != null) {
        try {
          await focusTab(j.openerTabId);
        } catch (_) {}
      }
    }, 3200);
  }
  return { ok, removed };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  withLock(async () => {
    const jobs = await getJobs();
    const j = jobs[tabId];
    if (!j) return;
    delete jobs[tabId];
    await setJobs(jobs);
    broadcast({ type: 'sync:done', ok: false, outcome: 'aborted', tweets: 0, added: 0, removed: 0, mode: j.mode });
  }).catch(() => {});
});

/* ---------- 备份 / 恢复 / 清空 ---------- */
async function doExport() {
  const items = await DB.getAll('items');
  const settings = await getSettings();
  return { app: 'x-bookmark-review', version: 2, exportedAt: new Date().toISOString(), settings, items };
}

async function doImport(data) {
  if (!data || data.app !== 'x-bookmark-review' || !Array.isArray(data.items)) {
    throw new Error('这不是本扩展导出的备份文件');
  }
  const cleaned = [];
  let bad = 0;
  for (const raw of data.items.slice(0, 50000)) {
    const base = PARSE.sanitizeItem(raw);
    if (base) cleaned.push({ base, raw });
    else bad++;
  }
  const prevs = await DB.getMany(
    'items',
    cleaned.map((c) => c.base.id)
  );
  const out = [];
  let existed = 0;
  cleaned.forEach((c, i) => {
    if (prevs[i]) {
      existed++;
      return;
    }
    const r = c.raw;
    const rec = Object.assign({}, c.base, {
      source: r.source === 'live' || r.source === 'dom' ? r.source : 'bookmarks',
      capturedAt: Number.isFinite(r.capturedAt) ? r.capturedAt : Date.now(),
      bookmarkedAt: PARSE.plausibleMs(r.bookmarkedAt) || null,
      lastSeenAt: Number.isFinite(r.lastSeenAt) ? r.lastSeenAt : 0,
      shownCount: clampInt(r.shownCount, 0, 1e6, 0),
      muted: !!r.muted,
      removed: !!r.removed,
      liked: !!r.liked,
      deleted: !!r.deleted,
      pv: clampInt(r.pv, 0, 99, 0), // 老备份没有这个字段 → 算「旧版读的」,提示重新同步补标题
    });
    if (rec.liked && Number.isFinite(r.likedAt)) rec.likedAt = r.likedAt;
    if (rec.deleted && Number.isFinite(r.deletedAt)) rec.deletedAt = r.deletedAt;
    if (Number.isInteger(r.reviewCount) && r.reviewCount >= 0) {
      rec.reviewCount = Math.min(r.reviewCount, 1e6);
      rec.lastReviewedAt = PARSE.plausibleMs(r.lastReviewedAt) || 0;
    }
    if (typeof r.lastShownDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.lastShownDay)) rec.lastShownDay = r.lastShownDay;
    out.push(rec);
  });
  await DB.putMany('items', out);
  await doPlan({});
  await updateBadge();
  return { added: out.length, existed, bad };
}

async function doClearAll() {
  await DB.clear('items');
  await DB.kvDel('plan');
  await DB.kvDel('sync');
  await DB.kvDel('lastNotifyDay');
  await updateBadge();
  return { ok: true };
}

async function doRestoreRemoved() {
  const all = await DB.getAll('items');
  const rows = all.filter((i) => i.removed);
  for (const it of rows) {
    it.removed = false;
    delete it.removedAt;
  }
  await DB.putMany('items', rows);
  await doPlan({});
  await updateBadge();
  return { restored: rows.length };
}

/* ---------- 打开回顾页 ---------- */
async function openApp(hash) {
  const url = APP_URL + (hash ? '#' + hash : '');
  try {
    const tabs = await chrome.tabs.query({ url: APP_URL + '*' });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, hash ? { active: true, url } : { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
      return { ok: true, reused: true };
    }
  } catch (_) {}
  await chrome.tabs.create({ url });
  return { ok: true, reused: false };
}

/* ---------- 闹钟:每日提醒 + 午夜换日 ---------- */
async function scheduleAlarms(force) {
  const s = await getSettings();
  const now = Date.now();
  if (s.reminderEnabled) {
    const cur = await chrome.alarms.get('xbr-reminder');
    if (force || !cur) {
      await chrome.alarms.clear('xbr-reminder');
      chrome.alarms.create('xbr-reminder', { when: P.nextOccurrence(now, s.reminderTime) });
    }
  } else {
    await chrome.alarms.clear('xbr-reminder');
  }
  const mid = await chrome.alarms.get('xbr-midnight');
  if (!mid) chrome.alarms.create('xbr-midnight', { when: P.nextMidnight(now) + 30000 });
}

async function doReminder() {
  const r = await doPlan({});
  await updateBadge();
  const remaining = remainingOf(r.plan);
  const today = P.dayKey();
  if (remaining > 0 && (await DB.kvGet('lastNotifyDay')) !== today) {
    await DB.kvSet('lastNotifyDay', today);
    const first = r.items.find((i) => !r.plan.done[i.id]);
    const text = first ? String(first.text || (first.card && first.card.title) || '').replace(/\s+/g, ' ') : '';
    const teaser = first ? (first.name || first.handle) + ':' + text.slice(0, 56) + (text.length > 56 ? '…' : '') : '点开看看今天抽到的书签';
    try {
      const p = chrome.notifications.create('xbr-today', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '今日回顾:' + remaining + ' 条 X 书签',
        message: teaser,
        priority: 0,
      });
      if (p && p.catch) p.catch(() => {});
    } catch (_) {}
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'xbr-reminder') {
    withLock(doReminder)
      .catch(() => {})
      .then(() => scheduleAlarms(true))
      .catch(() => {});
  } else if (a.name === 'xbr-midnight') {
    withLock(async () => {
      await doPlan({});
      await updateBadge();
    })
      .catch(() => {})
      .then(() => chrome.alarms.create('xbr-midnight', { when: P.nextMidnight(Date.now()) + 30000 }));
  }
});

chrome.notifications.onClicked.addListener((id) => {
  if (id === 'xbr-today') {
    openApp('today');
    chrome.notifications.clear(id);
  }
});

chrome.action.onClicked.addListener(() => {
  openApp('today');
});

async function startupActions() {
  const s = await getSettings();
  const today = P.dayKey();
  if (s.openOnStartup && (await DB.kvGet('lastOpenDay')) !== today) {
    await DB.kvSet('lastOpenDay', today);
    await openApp('today');
    return;
  }
  // 提醒时间已经过了、今天还没提醒过 → 补一条
  if (s.reminderEnabled && P.reminderPassed(Date.now(), s.reminderTime)) await withLock(doReminder);
}

chrome.runtime.onInstalled.addListener((d) => {
  withLock(async () => {
    await scheduleAlarms(true);
    await doPlan({});
    await updateBadge();
  })
    .catch(() => {})
    .then(() => {
      if (d.reason === 'install') return openApp('today');
    });
});

chrome.runtime.onStartup.addListener(() => {
  withLock(async () => {
    await scheduleAlarms(false);
    await doPlan({});
    await updateBadge();
  })
    .catch(() => {})
    .then(startupActions)
    .catch(() => {});
});

scheduleAlarms(false).catch(() => {}); // 每次后台被唤醒都确认一下闹钟还在

/* ---------- 消息路由 ---------- */
const ROUTES = {
  // 回顾页 → 后台
  state: { from: 'page', lock: true, fn: (m) => doState(m.view !== false) },
  done: { from: 'page', lock: true, fn: (m) => doDone(String(m.id), !!m.done) },
  mute: { from: 'page', lock: true, fn: (m) => setOut(String(m.id), 'muted', !!m.muted) },
  del: { from: 'page', lock: true, fn: (m) => setOut(String(m.id), 'deleted', !!m.deleted) },
  like: { from: 'page', lock: true, fn: (m) => doLike(String(m.id), !!m.liked) },
  more: { from: 'page', lock: true, fn: (m) => doMore(m.n) },
  reroll: {
    from: 'page',
    lock: true,
    fn: async () => {
      await doPlan({ reroll: true, view: true });
      await updateBadge();
      return { ok: true };
    },
  },
  list: { from: 'page', lock: false, fn: (m) => doList(m) },
  settings: { from: 'page', lock: true, fn: (m) => doSettings(m.patch || {}) },
  export: { from: 'page', lock: false, fn: () => doExport() },
  import: { from: 'page', lock: true, fn: (m) => doImport(m.data) },
  clearAll: { from: 'page', lock: true, fn: () => doClearAll() },
  restoreRemoved: { from: 'page', lock: true, fn: () => doRestoreRemoved() },
  // 回顾页或 X 页面都可以
  syncStart: { from: 'any', lock: true, fn: doSyncStart },
  openApp: { from: 'any', lock: false, fn: (m) => openApp(m.hash) },
  // X 页面 → 后台
  hello: { from: 'x', lock: true, fn: doHello },
  ingest: { from: 'x', lock: false, fn: doIngestMsg }, // 里面自己加锁
  unbookmark: { from: 'x', lock: true, fn: doUnbookmark },
  jobProgress: {
    from: 'x',
    lock: false,
    fn: (m) => {
      broadcast({ type: 'sync:progress', tweets: clampInt(m.tweets, 0, 1e7, 0), added: clampInt(m.added, 0, 1e7, 0) });
      return { ok: true };
    },
  },
  jobDone: { from: 'x', lock: true, fn: doJobDone },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const route = msg && typeof msg.type === 'string' && Object.prototype.hasOwnProperty.call(ROUTES, msg.type) ? ROUTES[msg.type] : null;
  if (!route) return; // 不是发给后台的(比如后台自己广播给页面的),别抢着回
  const fromPage = isExtPage(sender);
  const fromX = isXPage(sender);
  const allowed =
    (route.from === 'page' && fromPage) || (route.from === 'x' && fromX) || (route.from === 'any' && (fromPage || fromX));
  if (!allowed) {
    sendResponse({ ok: false, error: 'forbidden' });
    return;
  }
  const run = () => route.fn(msg, sender);
  (route.lock ? withLock(run) : Promise.resolve().then(run)).then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
  );
  return true;
});
