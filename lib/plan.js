/* 每日抽取逻辑:新内容随机抽取,旧内容按间隔复习优先级抽取。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XBR_PLAN = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');

  /** 本地日期 YYYY-MM-DD(每天 0 点换日) */
  function dayKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** 可复现的随机数(测试用) */
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    rng = rng || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  const DAILY_COUNTS = Object.freeze([4, 8, 12, 18, 24]);

  /** 旧设置如果已固定为可选条数就沿用,旧区间统一用 12 条。 */
  function planTarget(settings = {}) {
    const { dailyCount, countMin, countMax } = settings;
    if (DAILY_COUNTS.includes(dailyCount)) return dailyCount;
    if (countMin === countMax && DAILY_COUNTS.includes(countMin)) return countMin;
    return 12;
  }

  function isEligible(it) {
    return !!it && !it.muted && !it.removed && !it.deleted;
  }

  const DAY_MS = 86400000;
  const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30, 60];

  function reviewHistory(item) {
    if (Number.isInteger(item.reviewCount) && item.reviewCount >= 0) {
      return { reviewCount: item.reviewCount, lastReviewedAt: item.lastReviewedAt || 0 };
    }
    // 旧版只记录展示,以最后展示日期作为一次复习的近似值。
    const shownAt = Date.parse(item.lastShownDay + 'T00:00:00');
    return { reviewCount: item.shownCount > 0 ? 1 : 0, lastReviewedAt: Number.isFinite(shownAt) ? shownAt : 0 };
  }

  // 相当于按估算记忆留存率 2^(-elapsed/interval) 从低到高排。
  function reviewPriority(history, now) {
    if (!history.lastReviewedAt) return Infinity;
    const interval = REVIEW_INTERVALS[Math.min(history.reviewCount, REVIEW_INTERVALS.length) - 1];
    return Math.max(0, now - history.lastReviewedAt) / (interval * DAY_MS);
  }

  /**
   * 抽 n 条。
   * opts.exclude  硬排除(绝不出现,比如今天已经抽到的)
   * opts.avoid    软排除(优先避开,池子不够时才用,比如"重新抽取"时避开刚才那批)
   */
  function pickItems(items, n, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random;
    if (!(n > 0)) return [];
    const exclude = opts.exclude || new Set();
    const avoid = opts.avoid || new Set();
    const pool = items.filter((it) => isEligible(it) && !exclude.has(it.id));
    const now = opts.now ?? Date.now();
    const fresh = [];
    const review = [];
    const deferred = [];
    for (const item of shuffle(pool, rng)) {
      const history = reviewHistory(item);
      if (avoid.has(item.id)) deferred.push(item.id);
      else if (history.reviewCount) review.push({ id: item.id, priority: reviewPriority(history, now) });
      else fresh.push(item.id);
    }
    review.sort((a, b) => b.priority - a.priority);
    const oldIds = review.map((item) => item.id);
    const oldQuota = opts.oldQuota ?? Math.round(n / 3);
    const newQuota = n - oldQuota;
    const selected = fresh.slice(0, newQuota).concat(oldIds.slice(0, oldQuota));
    const spare = fresh.slice(newQuota).concat(oldIds.slice(oldQuota), deferred);
    return shuffle(selected.concat(spare.slice(0, n - selected.length)), rng);
  }

  /** 新建一天的计划 */
  function newPlan(items, settings, today, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random;
    const target = planTarget(settings);
    const now = opts.now ?? Date.now();
    const ids = pickItems(items, target, { rng, avoid: opts.avoid, now });
    const selected = new Set(ids);
    const reviewIds = items.filter((item) => selected.has(item.id) && reviewHistory(item).reviewCount > 0).map((item) => item.id);
    return { day: today, target, ids, reviewIds, done: {}, seen: false, createdAt: now };
  }

  /**
   * 计划里的条目不再合格(被静音/已取消收藏)就拿掉,目标数同步减少,
   * 这样"不再回顾"一条之后不会冒出一条替补。返回被拿掉的 id。
   */
  function dropIneligible(plan, byId) {
    const dropped = [];
    const keep = [];
    for (const id of plan.ids) {
      if (isEligible(byId.get(id))) keep.push(id);
      else dropped.push(id);
    }
    if (dropped.length) {
      plan.ids = keep;
      plan.target = Math.max(0, plan.target - dropped.length);
      for (const id of dropped) delete plan.done[id];
    }
    return dropped;
  }

  /** 条目比目标数少、池子里还有别的(首次同步后常见)→ 补齐。返回新增的 id。 */
  function topUpPlan(plan, items, rng) {
    const need = plan.target - plan.ids.length;
    if (need <= 0) return [];
    const exclude = new Set(plan.ids);
    // 已有计划没有记录抽取时的新旧分类,只在需要补齐时补记。
    if (!plan.reviewIds) plan.reviewIds = items.filter((item) => exclude.has(item.id) && reviewHistory(item).reviewCount > 0).map((item) => item.id);
    const oldCount = new Set(plan.reviewIds.filter((id) => exclude.has(id))).size;
    const oldQuota = Math.min(need, Math.max(0, Math.round(plan.target / 3) - oldCount));
    const extra = pickItems(items, need, { rng, exclude, oldQuota });
    for (const id of extra) plan.ids.push(id);
    const added = new Set(extra);
    for (const item of items) {
      if (added.has(item.id) && reviewHistory(item).reviewCount > 0) plan.reviewIds.push(item.id);
    }
    return extra;
  }

  function parseHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
    if (!m) return { h: 9, m: 0 };
    return { h: Math.min(23, +m[1]), m: Math.min(59, +m[2]) };
  }

  /** 下一次本地时间 HH:MM(严格晚于 now)的毫秒时间戳 */
  function nextOccurrence(now, hhmm) {
    const t = parseHHMM(hhmm);
    const d = new Date(now);
    d.setHours(t.h, t.m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  /** 下一个本地 0 点 */
  function nextMidnight(now) {
    const d = new Date(now);
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  /** 今天的提醒时间点是不是已经过了 */
  function reminderPassed(now, hhmm) {
    const t = parseHHMM(hhmm);
    const d = new Date(now);
    d.setHours(t.h, t.m, 0, 0);
    return now >= d.getTime();
  }

  return {
    dayKey,
    makeRng,
    shuffle,
    DAILY_COUNTS,
    planTarget,
    isEligible,
    reviewHistory,
    pickItems,
    newPlan,
    dropIneligible,
    topUpPlan,
    parseHHMM,
    nextOccurrence,
    nextMidnight,
    reminderPassed,
  };
});
