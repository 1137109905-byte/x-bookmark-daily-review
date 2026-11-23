'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/parse.js');
const F = require('./fixtures.js');

test('opFromUrl 取出 GraphQL 操作名', () => {
  assert.equal(P.opFromUrl('https://x.com/i/api/graphql/AbC_123-x/Bookmarks?variables=%7B%7D'), 'Bookmarks');
  assert.equal(P.opFromUrl('/i/api/graphql/zzz/CreateBookmark'), 'CreateBookmark');
  assert.equal(P.opFromUrl('https://x.com/home'), '');
  assert.ok(P.isBookmarkOp('Bookmarks'));
  assert.ok(!P.isBookmarkOp('CreateBookmark'));
});

test('新结构(core + avatar)和旧结构(legacy)都能读出作者', () => {
  const a = P.normalizeTweet(F.tweetResult({ id: '1700000000000000001', handle: 'new_user', name: '新结构', schema: 'new' }));
  assert.equal(a.handle, 'new_user');
  assert.equal(a.name, '新结构');
  assert.match(a.avatar, /^https:\/\/pbs\.twimg\.com\/profile_images\//);
  assert.equal(a.verified, true);
  assert.equal(a.url, 'https://x.com/new_user/status/1700000000000000001');

  const b = P.normalizeTweet(F.tweetResult({ id: '1700000000000000002', handle: 'old_user', name: '旧结构', schema: 'old' }));
  assert.equal(b.handle, 'old_user');
  assert.equal(b.name, '旧结构');
  assert.match(b.avatar, /twimg\.com/);
  assert.equal(b.verified, false);
});

test('长推文用 note_tweet 的全文', () => {
  const long = '第一段。\n\n' + '很长的正文'.repeat(200);
  const r = P.normalizeTweet(F.tweetResult({ id: '1700000000000000003', text: '被截断的前半段…', long }));
  assert.equal(r.text, long.trim());
});

test('回复:去掉开头的 @提及,记下 replyTo', () => {
  const r = P.normalizeTweet(F.tweetResult({ id: '1700000000000000004', text: '这是回复正文', reply: 'someone' }));
  assert.equal(r.text, '这是回复正文');
  assert.equal(r.replyTo, 'someone');
});

test('display_text_range 按码点算,含 emoji 也不会切歪', () => {
  const r = P.normalizeTweet(F.tweetResult({ id: '1700000000000000005', text: '👍🏽 好用 🎉', reply: 'a_b' }));
  assert.equal(r.text, '👍🏽 好用 🎉');
});

test('t.co 展开成真实链接,媒体和引用的短链被去掉,HTML 实体还原', () => {
  const r = P.normalizeTweet(
    F.tweetResult({
      id: '1700000000000000006',
      text: '看这个 https://t.co/abc &amp; 那个 &lt;tag&gt;',
      urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/post?a=1', display_url: 'example.com/post' }],
      photos: 1,
      quotePermalink: 'https://t.co/quote1',
    })
  );
  assert.equal(r.text, '看这个 https://example.com/post?a=1 & 那个 <tag>');
  assert.ok(!r.text.includes('t.co'));
});

test('媒体:多图、视频取码率最高的 mp4、gif', () => {
  const r = P.normalizeTweet(F.tweetResult({ id: '1700000000000000007', text: '带媒体', photos: 2, video: true, gif: true }));
  assert.equal(r.media.length, 4);
  assert.equal(r.media[0].type, 'photo');
  assert.equal(r.media[0].alt, '示例图片');
  const v = r.media.find((m) => m.type === 'video');
  assert.match(v.video, /high\.mp4$/);
  const g = r.media.find((m) => m.type === 'animated_gif');
  assert.match(g.video, /g1\.mp4$/);
});

test('引用推文只带精简信息,且不会无限嵌套', () => {
  const inner = F.tweetResult({ id: '1700000000000000009', handle: 'inner_user', name: '被引用的人', text: '被引用的话', photos: 1 });
  const outer = F.tweetResult({ id: '1700000000000000008', text: '我的评论', quoted: inner, quotePermalink: 'https://t.co/q' });
  const r = P.normalizeTweet(outer);
  assert.equal(r.text, '我的评论');
  assert.equal(r.quoted.id, '1700000000000000009');
  assert.equal(r.quoted.handle, 'inner_user');
  assert.equal(r.quoted.text, '被引用的话');
  assert.equal(r.quoted.media.length, 1);
});

test('TweetWithVisibilityResults 包装要拆开,墓碑要跳过', () => {
  const w = P.normalizeTweet(F.tweetResult({ id: '1700000000000000010', text: '包装过的', wrap: true }));
  assert.equal(w.text, '包装过的');
  assert.equal(P.normalizeTweet(F.tombstone()), null);
  assert.equal(P.normalizeTweet(null), null);
  assert.equal(P.normalizeTweet({ __typename: 'Tweet', rest_id: '17000000000000000' }), null); // 没有 legacy
});

test('转推:取原推文', () => {
  const orig = F.tweetResult({ id: '1700000000000000011', handle: 'orig', name: '原作者', text: '原文' });
  const rt = F.tweetResult({ id: '1700000000000000012', handle: 'retweeter', text: 'RT @orig: 原文' });
  rt.legacy.retweeted_status_result = { result: orig };
  const r = P.normalizeTweet(rt);
  assert.equal(r.id, '1700000000000000011');
  assert.equal(r.handle, 'orig');
});

test('书签页:取出推文、sortIndex、底部游标,墓碑计入 unavailable', () => {
  const page = F.bookmarksResponse(
    [
      { result: F.tweetResult({ id: '1700000000000000020', text: 'A' }), sortIndex: '1800000000000000002' },
      { result: F.tombstone(), sortIndex: '1800000000000000001' },
      { result: F.tweetResult({ id: '1700000000000000021', text: 'B', wrap: true }), sortIndex: '1800000000000000000' },
    ],
    'CURSOR_NEXT'
  );
  const tl = P.parseTimeline(page);
  assert.equal(tl.items.length, 2);
  assert.equal(tl.tweetEntries, 3);
  assert.equal(tl.unavailable, 1);
  assert.equal(tl.cursorBottom, 'CURSOR_NEXT');
  assert.equal(tl.items[0].sortIndex, '1800000000000000002');
});

test('最后一页只有游标、没有推文条目 → tweetEntries 为 0', () => {
  const tl = P.parseTimeline(F.bookmarksResponse([], null));
  assert.equal(tl.tweetEntries, 0);
  assert.equal(tl.items.length, 0);
  assert.equal(tl.cursorBottom, null);
});

test('搜索书签的另一层结构也能找到 instructions', () => {
  const inner = F.bookmarksResponse([{ result: F.tweetResult({ id: '1700000000000000030', text: 'S' }), sortIndex: '1' }], 'c');
  const json = { data: { search_by_raw_query: { bookmarks_search_timeline: inner.data.bookmark_timeline_v2 } } };
  assert.equal(P.parseTimeline(json).items.length, 1);
});

test('任意响应里找推文并去重(含被引用的)', () => {
  const inner = F.tweetResult({ id: '1700000000000000041', text: '内层' });
  const outer = F.tweetResult({ id: '1700000000000000040', text: '外层', quoted: inner });
  const json = F.homeResponse([outer, F.tweetResult({ id: '1700000000000000042', text: '另一条' }), outer]);
  const ids = P.parseAnyTweets(json).map((t) => t.id).sort();
  assert.deepEqual(ids, ['1700000000000000040', '1700000000000000041', '1700000000000000042']);
});

test('雪花 ID 往返,乱数不当日期', () => {
  const ms = Date.UTC(2025, 5, 1, 12, 0, 0);
  const id = F.snowflakeFromMs(ms, 7);
  assert.equal(P.snowflakeMs(id), ms);
  assert.equal(P.plausibleMs(ms), ms);
  assert.equal(P.plausibleMs(5), null);
  assert.equal(P.plausibleMs(P.snowflakeMs('not-a-number')), null);
});

test('入库清洗:坏 id 拒收,非 CDN 头像丢弃,链接按 handle 重建', () => {
  assert.equal(P.sanitizeItem({ id: 'abc' }), null);
  assert.equal(P.sanitizeItem(null), null);
  const r = P.sanitizeItem({
    id: '1700000000000000050',
    handle: 'ok_user<script>',
    name: 'N',
    avatar: 'https://evil.example.com/a.png',
    url: 'https://evil.example.com/phish',
    text: 't',
    media: [
      { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' },
      { type: 'photo', url: 'javascript:alert(1)' },
      { type: 'video', url: 'https://pbs.twimg.com/x.jpg', video: 'http://video.twimg.com/insecure.mp4' },
    ],
    createdAt: 'garbage',
  });
  assert.equal(r.handle, 'ok_userscript');
  assert.equal(r.avatar, '');
  assert.equal(r.url, 'https://x.com/ok_userscript/status/1700000000000000050');
  assert.equal(r.media.length, 2);
  assert.equal(r.media[1].video, '');
  assert.equal(r.createdAt, null);
});

test('解析真实形状的整页,字段齐全', () => {
  const items = [];
  for (let i = 0; i < 20; i++) {
    items.push({
      // 推文 ID 超出 JS 数字的精确范围,必须用 BigInt 造,否则 20 个 ID 会糊成同一个
      result: F.tweetResult({ id: String(1700000000000000100n + BigInt(i)), text: '第 ' + i + ' 条', photos: i % 3 }),
      sortIndex: F.snowflakeFromMs(Date.UTC(2025, 0, 1) + i * 1000),
    });
  }
  const tl = P.parseTimeline(F.bookmarksResponse(items, 'next'));
  assert.equal(tl.items.length, 20);
  for (const it of tl.items) {
    const s = P.sanitizeItem(it);
    assert.ok(s, '清洗后应保留');
    assert.equal(s.text.startsWith('第 '), true);
    assert.ok(P.plausibleMs(P.snowflakeMs(s.sortIndex)), 'sortIndex 能还原成时间');
  }
});
