'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/plan.js');

const mk = (n, extra) => Array.from({ length: n }, (_, i) => Object.assign({ id: 'id' + i, shownCount: 0 }, extra && extra(i)));

test('条数区间:整理成合法范围', () => {
  assert.deepEqual(P.normalizeRange({ countMin: 4, countMax: 24 }), { min: 4, max: 24 });
  assert.deepEqual(P.normalizeRange({ countMin: 30, countMax: 10 }), { min: 30, max: 30 }); // max 不能小于 min
  assert.deepEqual(P.normalizeRange({ countMin: 0, countMax: 999 }), { min: 1, max: 100 });
  assert.deepEqual(P.normalizeRange({}), { min: 4, max: 24 });
  assert.deepEqual(P.normalizeRange({ countMin: 'abc', countMax: null }), { min: 4, max: 24 });
});

test('每天条数在区间内随机,两端都取得到;最少=最多就是固定', () => {
  const rng = P.makeRng(42);
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    const t = P.planTarget({ countMin: 4, countMax: 24 }, rng);
    assert.ok(t >= 4 && t <= 24);
    seen.add(t);
  }
  assert.equal(seen.size, 21, '4~24 共 21 个取值都应出现');
  for (let i = 0; i < 50; i++) assert.equal(P.planTarget({ countMin: 8, countMax: 8 }, rng), 8);
});

test('抽取:不重复、只抽合格的、不超过池子大小', () => {
  const items = mk(30, (i) => ({ muted: i < 5, removed: i >= 5 && i < 8 }));
  const ids = P.pickItems(items, 10, { rng: P.makeRng(1) });
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10);
  for (const id of ids) {
    const n = Number(id.slice(2));
    assert.ok(n >= 8, id + ' 不应是静音/已移除的');
  }
  assert.equal(P.pickItems(items, 100, { rng: P.makeRng(1) }).length, 22); // 池子只有 22 条
  assert.deepEqual(P.pickItems(items, 0), []);
  assert.deepEqual(P.pickItems([], 5), []);
});

test('硬排除绝不出现,软排除只在池子不够时才用', () => {
  const items = mk(10);
  const ex = new Set(['id0', 'id1', 'id2']);
  const a = P.pickItems(items, 10, { rng: P.makeRng(2), exclude: ex });
  assert.equal(a.length, 7);
  assert.ok(!a.some((id) => ex.has(id)));
  const b = P.pickItems(items, 7, { rng: P.makeRng(2), avoid: ex });
  assert.ok(!b.some((id) => ex.has(id)), '池子够,就不该用被回避的');
  const c = P.pickItems(items, 10, { rng: P.makeRng(2), avoid: ex });
  assert.equal(c.length, 10, '池子不够时,软排除的补进来');
});

test('出现次数少的优先:次数为 0 的全部抽完才轮到次数为 1 的', () => {
  const items = mk(20, (i) => ({ shownCount: i < 6 ? 0 : i < 12 ? 1 : 2 }));
  const ids = P.pickItems(items, 9, { rng: P.makeRng(3) });
  const zeros = ids.filter((id) => Number(id.slice(2)) < 6);
  assert.equal(zeros.length, 6, '6 条次数为 0 的必须全在');
  const ones = ids.filter((id) => { const n = Number(id.slice(2)); return n >= 6 && n < 12; });
  assert.equal(ones.length, 3);
});

test('整库轮一遍之前不重复:100 条、每天 10 条,10 天正好各一次', () => {
  const items = mk(100);
  const rng = P.makeRng(7);
  const count = new Map();
  for (let day = 0; day < 10; day++) {
    const ids = P.pickItems(items, 10, { rng });
    for (const id of ids) {
      const it = items.find((x) => x.id === id);
      it.shownCount++;
      count.set(id, (count.get(id) || 0) + 1);
    }
  }
  assert.equal(count.size, 100);
  for (const v of count.values()) assert.equal(v, 1);
  // 第 11 天开始第二轮
  const again = P.pickItems(items, 10, { rng });
  assert.equal(again.length, 10);
});

test('同一档内是均匀随机的(粗检)', () => {
  const items = mk(10);
  const rng = P.makeRng(99);
  const hits = new Array(10).fill(0);
  const N = 5000;
  for (let i = 0; i < N; i++) hits[Number(P.pickItems(items, 1, { rng })[0].slice(2))]++;
  for (const h of hits) assert.ok(h > N / 10 * 0.8 && h < N / 10 * 1.2, '各条被抽到的次数应接近 ' + N / 10 + ',实际 ' + h);
});

test('新建计划:条数在区间内,不超过池子;池子为空也不报错', () => {
  const plan = P.newPlan(mk(50), { countMin: 4, countMax: 24 }, '2026-11-12', { rng: P.makeRng(5), now: 123 });
  assert.equal(plan.day, '2026-11-12');
  assert.ok(plan.target >= 4 && plan.target <= 24);
  assert.equal(plan.ids.length, plan.target);
  assert.equal(plan.seen, false);
  const small = P.newPlan(mk(3), { countMin: 10, countMax: 10 }, '2026-11-12', { rng: P.makeRng(5) });
  assert.equal(small.target, 10);
  assert.equal(small.ids.length, 3);
  const empty = P.newPlan([], { countMin: 4, countMax: 24 }, '2026-11-12');
  assert.deepEqual(empty.ids, []);
});

test('补齐:首次同步后池子变大,计划补到目标数;够数就不动', () => {
  const plan = { day: 'd', target: 12, ids: ['id0', 'id1', 'id2'], done: {}, seen: false };
  const added = P.topUpPlan(plan, mk(50), P.makeRng(8));
  assert.equal(added.length, 9);
  assert.equal(plan.ids.length, 12);
  assert.equal(new Set(plan.ids).size, 12);
  assert.deepEqual(P.topUpPlan(plan, mk(50), P.makeRng(8)), []);
});

test('静音/移除:从计划里拿掉,目标数同步减少,不冒替补', () => {
  const items = mk(10);
  items[1].muted = true;
  items[2].removed = true;
  const byId = new Map(items.map((i) => [i.id, i]));
  const plan = { day: 'd', target: 5, ids: ['id0', 'id1', 'id2', 'id3', 'id4'], done: { id1: 1, id3: 2 }, seen: true };
  const dropped = P.dropIneligible(plan, byId);
  assert.deepEqual(dropped, ['id1', 'id2']);
  assert.deepEqual(plan.ids, ['id0', 'id3', 'id4']);
  assert.equal(plan.target, 3);
  assert.deepEqual(plan.done, { id3: 2 });
  assert.deepEqual(P.topUpPlan(plan, items, P.makeRng(1)), [], '目标数减过了,不会补');
});

test('时间:日期键、下一次提醒、下一个 0 点、提醒是否已过', () => {
  const d = new Date(2026, 10, 12, 8, 30, 0); // 本地 2026-11-12 08:30
  assert.equal(P.dayKey(d), '2026-11-12');
  assert.equal(P.dayKey(new Date(2026, 0, 5)), '2026-01-05');

  const t1 = new Date(P.nextOccurrence(d.getTime(), '09:00'));
  assert.equal(P.dayKey(t1), '2026-11-12');
  assert.equal(t1.getHours(), 9);
  const t2 = new Date(P.nextOccurrence(d.getTime(), '08:00')); // 今天 8 点已过 → 明天
  assert.equal(P.dayKey(t2), '2026-11-13');
  const t3 = new Date(P.nextOccurrence(d.getTime(), '08:30')); // 正好等于 now → 明天(严格晚于)
  assert.equal(P.dayKey(t3), '2026-11-13');
  const t4 = new Date(P.nextOccurrence(d.getTime(), 'bad')); // 非法 → 默认 09:00
  assert.equal(t4.getHours(), 9);

  const m = new Date(P.nextMidnight(d.getTime()));
  assert.equal(P.dayKey(m), '2026-11-13');
  assert.equal(m.getHours(), 0);

  assert.equal(P.reminderPassed(d.getTime(), '08:00'), true);
  assert.equal(P.reminderPassed(d.getTime(), '09:00'), false);
});
