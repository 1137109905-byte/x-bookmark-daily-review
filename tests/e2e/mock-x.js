'use strict';
/* 模拟 x.com:一个本地 HTTPS 服务器,假装成 X 的书签页、首页和 GraphQL 接口。
 * 浏览器用 --host-resolver-rules 把 x.com / pbs.twimg.com 指到这里,
 * 扩展的内容脚本会在「https://x.com」上真实运行,但碰不到真正的 X。
 * 所有账号和内容都是虚构的。 */
const https = require('https');
const fs = require('fs');
const F = require('../fixtures.js');

const BASE_ID = 1860000000000000000n;

const AUTHORS = [
  { handle: 'demo_writer', name: '示例作者' },
  { handle: 'sample_dev', name: '示例开发者' },
  { handle: 'fiction_chef', name: '虚构厨房' },
  { handle: 'demo_reader', name: '读书笔记(示例)' },
  { handle: 'sample_designer', name: '示例设计师' },
];

const TEXTS = [
  '把「每天固定 20 分钟整理收件箱」当成习惯,比一次性大扫除有效得多。',
  '做小工具有个窍门:先让它丑,但今天就能用上。第二天再决定值不值得打磨。',
  '周末试了一道新菜:番茄先炒出沙,再下鸡蛋,汤底会更浓。做法记在这里 https://t.co/ex1',
  '读完一本书,只写三句话:它让我改变了什么看法?我马上能做什么?我还想问作者什么?',
  '设计评审时先说「我看到了什么」,再说「我感觉到什么」,最后才说「我建议」。顺序一换,争论少一半。',
  '备份只有「恢复演练过」才算备份。',
  '记录:今天把旧笔记迁移到了新的文件夹结构,按「项目 / 领域 / 资料 / 归档」四类放。\n\n迁移时发现一半的东西其实不需要留。',
  '工具再好,也比不上一个愿意每天打开它的理由。',
  '写文档的人和读文档的人,永远不是同一个时刻的同一个人。所以要写给「三个月后的自己」。',
  '早上先做最小的一件事,哪怕只有五分钟。启动比坚持更难。',
  '#学习方法 间隔重复的关键不是「多看几遍」,而是「在快忘记的时候再看一遍」。',
  '一个小实验:把手机的主屏幕只留 8 个图标,一周后再决定要不要加回来。',
];

const LONG_TEXT =
  '这是一条很长的帖子(示例),用来检验「长推文」是否被完整收下,而不是只收到被截断的前半段。\n\n' +
  '第一段:很多人收藏了大量内容,却再也没有打开过。收藏本身给人一种「我已经拥有它」的错觉,但真正的吸收发生在回顾的时候。\n\n' +
  '第二段:所以一个好的回顾机制,不需要复杂,只需要每天固定地、随机地把旧东西推到你面前,让你有机会再想一遍。\n\n' +
  '第三段:随机很重要,因为它让你不按时间顺序面对自己的过去,经常会撞上意想不到的联系。';

function twDate(ms) {
  const d = new Date(ms);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p = (n) => String(n).padStart(2, '0');
  return day + ' ' + mon + ' ' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' +0000 ' + d.getUTCFullYear();
}

function makeState() {
  const now = Date.now();
  const st = { mode: 'normal', bmRequests: 0, videoRequests: 0, counter: 0, items: [], created: [], deleted: [], home: [] };
  for (let i = 1; i <= 90; i++) st.items.push(makeItem(st, i, now - (90 - i) * 3600e3 * 7, now - (90 - i) * 3600e3));
  st.items.reverse(); // 最新的在最前
  for (let k = 0; k < 3; k++) {
    st.home.push(makeItem(st, 9000 + k, now - k * 600e3, now, { homeOnly: true, text: '首页时间线上的一条(示例 ' + (k + 1) + '):点右边的按钮就是「收藏」。' }));
  }
  return st;
}

function makeItem(st, n, createdMs, bookmarkedMs, over) {
  const it = {
    id: String(BASE_ID + BigInt(n)),
    n,
    a: n % AUTHORS.length,
    text: TEXTS[n % TEXTS.length],
    createdMs,
    bookmarkedMs,
    tomb: n % 30 === 29 && !(over && over.homeOnly),
    photos: n % 7 === 1 ? 1 : n % 11 === 2 ? 2 : n % 13 === 3 ? 3 : n % 17 === 4 ? 4 : 0,
    video: n % 19 === 5,
    quote: n % 9 === 6,
    long: n % 23 === 7 ? LONG_TEXT : '',
    reply: n % 8 === 0,
    wrap: n % 10 === 3,
  };
  if (it.long) it.text = '(长帖,前半段)' + it.text;
  if (it.text.includes('https://t.co/ex1')) it.urls = [{ url: 'https://t.co/ex1', expanded_url: 'https://example.com/recipe', display_url: 'example.com/recipe' }];
  return Object.assign(it, over || {});
}

function toResult(it) {
  if (it.tomb) return F.tombstone();
  const a = AUTHORS[it.a];
  const qa = AUTHORS[(it.a + 1) % AUTHORS.length];
  const quoted = it.quote
    ? F.tweetResult({ id: String(BigInt(it.id) + 700n), handle: qa.handle, name: qa.name, text: '被引用的原帖(示例):先把问题写清楚,答案会自己长出来。', createdAt: twDate(it.createdMs - 864e5) })
    : null;
  return F.tweetResult({
    id: it.id,
    handle: a.handle,
    name: a.name,
    text: it.text,
    createdAt: twDate(it.createdMs),
    photos: it.photos,
    photoId: 'P' + it.id.slice(-4) + '_',
    video: it.video,
    quoted,
    quotePermalink: quoted ? 'https://t.co/q' + it.id.slice(-3) : '',
    long: it.long,
    reply: it.reply ? AUTHORS[(it.a + 2) % AUTHORS.length].handle : '',
    urls: it.urls || [],
    wrap: it.wrap,
    schema: it.a % 2 ? 'old' : 'new',
  });
}

/** 给模拟页面自己渲染 DOM 用的简化数据(不属于 GraphQL 结构,扩展不会读它) */
function renderInfo(it) {
  const a = AUTHORS[it.a];
  return { id: it.id, handle: a.handle, name: a.name, text: it.text, createdAt: new Date(it.createdMs).toISOString(), photos: it.photos };
}

function bookmarksPage(st, offset) {
  const real = st.items;
  const slice = real.slice(offset, offset + 20);
  const results = slice.map((it, i) => ({ result: toResult(it), sortIndex: F.snowflakeFromMs(it.bookmarkedMs, i) }));
  let json = F.bookmarksResponse(results, 'c' + (offset + 20));
  json.__render = slice.filter((it) => !it.tomb).map(renderInfo);
  json.__next = 'c' + (offset + 20);
  let text = JSON.stringify(json);
  if (st.mode === 'broken') text = text.replace(/"tweet_results"/g, '"tweet_result_v2"'); // 模拟 X 改版:换了字段名
  return text;
}

const PAGE_STYLE =
  'body{margin:0;font:15px/1.5 -apple-system,"PingFang SC",sans-serif;background:#fff;color:#0f1419}' +
  'article{height:220px;box-sizing:border-box;padding:14px 16px;border-bottom:1px solid #eff3f4;overflow:hidden}' +
  '.u{font-weight:700}.t{margin-top:8px}button{margin-left:8px}';

const ARTICLE_JS =
  'function art(it){var a=document.createElement("article");a.setAttribute("data-testid","tweet");a.setAttribute("data-id",it.id);' +
  'a.innerHTML=\'<div data-testid="Tweet-User-Avatar"><img width=40 height=40 src="https://pbs.twimg.com/profile_images/1/a_normal.jpg"></div>\'+' +
  '\'<div data-testid="User-Name"><a role="link" href="/\'+it.handle+\'"><span>\'+it.name+\'</span></a> <a role="link" href="/\'+it.handle+\'"><span>@\'+it.handle+\'</span></a> · ' +
  '<a href="/\'+it.handle+\'/status/\'+it.id+\'"><time datetime="\'+it.createdAt+\'">\'+it.createdAt.slice(0,10)+\'</time></a></div>\'+' +
  '\'<div data-testid="tweetText"><span></span></div>\';' +
  'a.querySelector("[data-testid=tweetText] span").textContent=it.text;return a;}';

function bookmarksHtml() {
  return (
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>书签 / X</title><style>' + PAGE_STYLE + '</style></head><body>' +
    '<div id="list"></div><div style="height:80px;text-align:center">…</div><script>' +
    ARTICLE_JS +
    '(function(){var cursor=null,loading=false,done=false,list=document.getElementById("list");' +
    'async function more(){if(loading||done)return;loading=true;try{' +
    'var v=encodeURIComponent(JSON.stringify({count:20,cursor:cursor}));' +
    'var res=await fetch("/i/api/graphql/QIDBM/Bookmarks?variables="+v,{credentials:"include"});' +
    'if(res.status!==200){loading=false;return}var json=await res.json();var r=json.__render||[];' +
    'r.forEach(function(it){list.appendChild(art(it))});cursor=json.__next||null;if(!r.length&&!document.querySelector("article"))done=false;' +
    'if(!json.__render||json.__render.length===0)done=true;}catch(e){}loading=false}' +
    'addEventListener("scroll",function(){if(innerHeight+scrollY>=document.documentElement.scrollHeight-900)more()});more()})();' +
    '</script></body></html>'
  );
}

function homeHtml(st) {
  const data = JSON.stringify(st.home.map(renderInfo));
  return (
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>首页 / X</title><style>' + PAGE_STYLE + '</style></head><body>' +
    '<div id="list"></div><script>' + ARTICLE_JS +
    '(function(){var list=document.getElementById("list");' +
    'fetch("/i/api/graphql/QIDHOME/HomeTimeline?variables=%7B%7D",{credentials:"include"}).then(function(r){return r.json()}).then(function(){' +
    'var items=' + data + ';items.forEach(function(it){var a=art(it);' +
    'var b1=document.createElement("button");b1.className="bm";b1.textContent="收藏";' +
    'b1.onclick=function(){fetch("/i/api/graphql/QIDCB/CreateBookmark",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({variables:{tweet_id:it.id},queryId:"QIDCB"})})};' +
    'var b2=document.createElement("button");b2.className="unbm";b2.textContent="取消收藏";' +
    'b2.onclick=function(){fetch("/i/api/graphql/QIDDB/DeleteBookmark",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({variables:{tweet_id:it.id},queryId:"QIDDB"})})};' +
    'a.appendChild(b1);a.appendChild(b2);list.appendChild(a)})})})();' +
    '</script></body></html>'
  );
}

function svgImage(pathname) {
  let h = 0;
  for (const c of pathname) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const label = decodeURIComponent(pathname.split('/').pop()).replace(/\.\w+$/, '');
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520" viewBox="0 0 800 520"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="hsl(' + hue + ',62%,62%)"/><stop offset="1" stop-color="hsl(' + ((hue + 50) % 360) + ',58%,42%)"/></linearGradient></defs>' +
    '<rect width="800" height="520" fill="url(#g)"/><circle cx="640" cy="130" r="60" fill="rgba(255,255,255,.22)"/>' +
    '<text x="48" y="470" font-family="sans-serif" font-size="34" fill="rgba(255,255,255,.85)">示例图片 ' + label.replace(/[<&]/g, '') + '</text></svg>'
  );
}

/** 把一个很小的 mp4 当作「视频」发出去(支持 Range,和真实 CDN 的行为一致) */
function serveVideo(req, res, file) {
  const buf = fs.readFileSync(file);
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const head = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? Math.min(parseInt(m[2], 10), buf.length - 1) : buf.length - 1;
    res.writeHead(206, Object.assign(head, { 'content-range': 'bytes ' + start + '-' + end + '/' + buf.length, 'content-length': end - start + 1 }));
    return res.end(buf.subarray(start, end + 1));
  }
  res.writeHead(200, Object.assign(head, { 'content-length': buf.length }));
  res.end(buf);
}

function startMock(opts) {
  const state = makeState();
  const server = https.createServer({ key: fs.readFileSync(opts.keyFile), cert: fs.readFileSync(opts.certFile) }, (req, res) => {
    const u = new URL(req.url, 'https://x.com');
    const p = u.pathname;
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (o) => send(200, 'application/json', JSON.stringify(o));
    const readBody = () => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

    if (state.mode === 'loggedout' && p === '/i/bookmarks') {
      // 没登录:X 会把书签页重定向到登录页
      res.writeHead(302, { location: '/i/flow/login', 'cache-control': 'no-store' });
      return res.end();
    }
    if (p === '/i/flow/login') {
      return send(200, 'text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><title>登录 X</title><body style="font:16px sans-serif;padding:40px"><h1>登录 X(模拟页面)</h1><p>这是测试用的假登录页。</p></body>');
    }
    if (p === '/i/bookmarks') return send(200, 'text/html; charset=utf-8', bookmarksHtml());
    if (p === '/home') return send(200, 'text/html; charset=utf-8', homeHtml(state));

    const gql = /^\/i\/api\/graphql\/[^/]+\/(\w+)$/.exec(p);
    if (gql) {
      const op = gql[1];
      if (op === 'Bookmarks') {
        state.bmRequests++;
        if (state.mode === 'fail403') return send(403, 'application/json', '{"errors":[{"message":"Forbidden"}]}');
        let cursor = null;
        try { cursor = JSON.parse(u.searchParams.get('variables') || '{}').cursor || null; } catch (_) {}
        const offset = cursor ? parseInt(cursor.slice(1), 10) || 0 : 0;
        return send(200, 'application/json', bookmarksPage(state, offset));
      }
      if (op === 'HomeTimeline') return json(F.homeResponse(state.home.map(toResult)));
      if (op === 'CreateBookmark' || op === 'DeleteBookmark') {
        return readBody().then((b) => {
          let id = '';
          try { id = String(JSON.parse(b).variables.tweet_id); } catch (_) {}
          if (op === 'CreateBookmark') {
            state.created.push(id);
            const h = state.home.find((x) => x.id === id);
            if (h && !state.items.find((x) => x.id === id)) state.items.unshift(Object.assign({}, h, { bookmarkedMs: Date.now(), homeOnly: false }));
            return json({ data: { tweet_bookmark_put: 'Done' } });
          }
          state.deleted.push(id);
          state.items = state.items.filter((x) => x.id !== id);
          return json({ data: { tweet_bookmark_delete: 'Done' } });
        });
      }
      return json({ data: {} });
    }

    if (p.startsWith('/__test/')) {
      const cmd = p.slice(8);
      if (cmd === 'mode') { state.mode = u.searchParams.get('m') || 'normal'; return json({ mode: state.mode }); }
      if (cmd === 'stats') {
        const out = { bmRequests: state.bmRequests, videoRequests: state.videoRequests, total: state.items.length, real: state.items.filter((x) => !x.tomb).length, created: state.created, deleted: state.deleted };
        if (u.searchParams.get('reset')) {
          state.bmRequests = 0;
          state.videoRequests = 0;
        }
        return json(out);
      }
      if (cmd === 'add') {
        const n = parseInt(u.searchParams.get('n') || '1', 10);
        const now = Date.now();
        for (let i = 0; i < n; i++) {
          state.counter = state.counter || 200;
          state.counter++;
          state.items.unshift(makeItem(state, state.counter, now - 3600e3, now + i, { text: '新收藏的一条(示例 ' + state.counter + '):这条是同步之后才加进来的。', tomb: false, photos: 0, video: false, quote: false, long: '', reply: false, wrap: false }));
        }
        return json({ ok: true, ids: state.items.slice(0, n).map((x) => x.id) });
      }
      if (cmd === 'remove') {
        const real = state.items.filter((x) => !x.tomb);
        const victims = real.slice(10, 10 + parseInt(u.searchParams.get('n') || '1', 10)).map((x) => x.id);
        state.items = state.items.filter((x) => !victims.includes(x.id));
        return json({ ok: true, ids: victims });
      }
      return send(404, 'text/plain', 'no such cmd');
    }

    if (opts.videoFile && /\.mp4$/.test(p)) {
      state.videoRequests++;
      return serveVideo(req, res, opts.videoFile);
    }
    if (/^\/(media|profile_images|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(p)) return send(200, 'image/svg+xml', svgImage(p));
    res.writeHead(204);
    res.end();
  });
  return new Promise((resolve) => server.listen(opts.port || 0, '127.0.0.1', () => resolve({ server, state, port: server.address().port, close: () => server.close() })));
}

module.exports = { startMock, AUTHORS };
