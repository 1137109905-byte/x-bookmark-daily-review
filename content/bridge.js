/* 运行在扩展的隔离环境(ISOLATED world)。职责:
 *  1. 接收 hook.js 旁听到的数据,解析后交给后台入库;
 *  2. 「实时收藏」:你在 X 上点书签的瞬间,把那条推文收进来;取消收藏则移出回顾池;
 *  3. 「同步」:自动滚动书签页,把整个列表读下来(网络数据优先,读不懂时退回读页面文字);
 *  4. 在页面右下角给一个小提示(进度、完成、出错)。
 * 依赖 lib/parse.js(manifest 里排在它前面)。 */
(function () {
  'use strict';
  if (window.__xbrBridge) return;
  window.__xbrBridge = true;

  var CH = 'xbr:v1';
  var PARSE = self.XBR_PARSE;
  if (!PARSE) return;
  var PAGE_T0 = Date.now(); // 本次页面生命周期的起点:同步时"本轮见过的"以此为界

  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };
  var rand = function (a, b) {
    return a + Math.random() * (b - a);
  };
  var isBookmarksPath = function () {
    return location.pathname.indexOf('/i/bookmarks') === 0;
  };
  function domReady() {
    return document.readyState !== 'loading'
      ? Promise.resolve()
      : new Promise(function (r) {
          document.addEventListener('DOMContentLoaded', r, { once: true });
        });
  }

  /* ================= 与后台通信 ================= */
  var dead = false;
  function onDead() {
    ui.toast('扩展刚更新过,请刷新这个页面', 6000);
  }
  function send(msg) {
    if (dead) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(msg).then(
        function (r) {
          return r && r.ok ? r.data : null;
        },
        function (e) {
          if (/context invalidated|receiving end/i.test(String(e && e.message))) {
            dead = true;
            onDead();
          }
          return null;
        }
      );
    } catch (e) {
      dead = true;
      onDead();
      return Promise.resolve(null);
    }
  }

  /* ================= 页面右下角的小提示 ================= */
  var ui = (function () {
    var host, root, box, pill, titleEl, msgEl, bar, btns, toastEl;
    var mounted = false;
    var toastTimer = 0;
    var pillHandler = null;

    var CSS =
      '[hidden]{display:none!important}' +
      '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}' +
      '.stack{display:flex;flex-direction:column;align-items:flex-end;gap:10px}' +
      '.pill{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:999px;padding:9px 15px;background:#2fa866;color:#fff;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.28)}' +
      '.pill:hover{background:#299a5d}' +
      '.box{width:290px;background:#15181c;color:#e7e9ea;border:1px solid #2f3336;border-radius:14px;padding:14px 14px 12px;box-shadow:0 10px 30px rgba(0,0,0,.45);font-size:13px;line-height:1.55}' +
      '.head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}' +
      '.title{font-size:14px;color:#fff}' +
      '.close{border:0;background:none;color:#8b98a5;font-size:18px;line-height:1;cursor:pointer;padding:0 2px}' +
      '.close:hover{color:#fff}' +
      '.msg{color:#c9d1d9;white-space:pre-line}' +
      '.bar{height:4px;border-radius:2px;background:#2f3336;margin-top:10px;overflow:hidden;position:relative}' +
      '.bar i{position:absolute;inset:0 auto 0 0;width:35%;border-radius:2px;background:#2fa866;animation:run 1.2s ease-in-out infinite}' +
      '@keyframes run{0%{left:-35%}100%{left:100%}}' +
      '.btns{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}' +
      '.btns button{border:1px solid #3a3f44;background:transparent;color:#e7e9ea;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}' +
      '.btns button.primary{background:#2fa866;border-color:#2fa866;color:#fff;font-weight:600}' +
      '.toast{background:#15181c;color:#e7e9ea;border:1px solid #2f3336;border-radius:10px;padding:8px 12px;font-size:12.5px;box-shadow:0 6px 20px rgba(0,0,0,.4)}';

    function mount() {
      if (mounted || !(document.body || document.documentElement)) return mounted;
      mounted = true;
      host = document.createElement('div');
      host.setAttribute('data-xbr', '1');
      host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:84px;z-index:2147483646;';
      root = host.attachShadow({ mode: 'closed' });
      root.innerHTML =
        '<style>' + CSS + '</style><div class="stack">' +
        '<div class="toast" hidden></div>' +
        '<div class="box" hidden><div class="head"><b class="title"></b><button class="close" aria-label="关闭">×</button></div>' +
        '<div class="msg"></div><div class="bar" hidden><i></i></div><div class="btns"></div></div>' +
        '<button class="pill" hidden>⟳ 同步书签到「书签回顾」</button></div>';
      toastEl = root.querySelector('.toast');
      box = root.querySelector('.box');
      titleEl = root.querySelector('.title');
      msgEl = root.querySelector('.msg');
      bar = root.querySelector('.bar');
      btns = root.querySelector('.btns');
      pill = root.querySelector('.pill');
      root.querySelector('.close').addEventListener('click', function () {
        box.hidden = true;
      });
      pill.addEventListener('click', function () {
        if (pillHandler) pillHandler();
      });
      (document.body || document.documentElement).appendChild(host);
      return true;
    }

    return {
      box: function (o) {
        if (!mount()) return;
        titleEl.textContent = o.title || '书签回顾';
        msgEl.textContent = o.msg || '';
        bar.hidden = !o.busy;
        btns.textContent = '';
        (o.buttons || []).forEach(function (b) {
          var el = document.createElement('button');
          el.textContent = b.label;
          if (b.primary) el.className = 'primary';
          el.addEventListener('click', b.onClick);
          btns.appendChild(el);
        });
        box.hidden = false;
      },
      hideBox: function () {
        if (mounted) box.hidden = true;
      },
      toast: function (text, ms) {
        if (!mount()) return;
        toastEl.textContent = text;
        toastEl.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
          toastEl.hidden = true;
        }, ms || 2200);
      },
      pill: function (show, handler) {
        if (!mount()) return;
        pillHandler = handler || pillHandler;
        pill.hidden = !show;
      },
    };
  })();

  /* ================= 解析与入库 ================= */
  var st = {
    pages: 0, // 已处理的书签页数(网络数据)
    tweets: 0, // 读到的推文条数
    added: 0, // 其中新增的
    reachedEnd: false,
    knownStreak: 0, // 连续"没有新增"的页数
    formatBroken: false, // 收到了带推文的响应却解析不出条目 → X 可能改版了
    bmStatus: null, // 书签请求出错 {status, at}
    ingests: Promise.resolve(),
    usedDom: false,
  };

  var cache = new Map(); // 最近见过的推文(内存里,给"实时收藏"用)
  function cachePut(rec) {
    cache.delete(rec.id);
    cache.set(rec.id, rec);
    if (cache.size > 800) cache.delete(cache.keys().next().value);
  }

  function onGql(msg) {
    var json;
    try {
      json = JSON.parse(msg.text);
    } catch (_) {
      return;
    }
    if (PARSE.isBookmarkOp(msg.op)) {
      var tl = PARSE.parseTimeline(json);
      st.pages++;
      st.tweets += tl.items.length;
      tl.items.forEach(cachePut);
      if (tl.tweetEntries === 0 && msg.text.indexOf('"full_text"') !== -1) st.formatBroken = true;
      else if (tl.tweetEntries === 0 || !tl.cursorBottom) st.reachedEnd = true;
      var items = tl.items;
      st.ingests = st.ingests.then(function () {
        if (!items.length) return null;
        return send({ type: 'ingest', source: 'bookmarks', items: items }).then(function (res) {
          var added = res ? res.added : 0;
          st.added += added;
          st.knownStreak = added === 0 ? st.knownStreak + 1 : 0;
        });
      });
      return;
    }
    PARSE.parseAnyTweets(json).forEach(cachePut);
  }

  function onMutation(msg) {
    if (!msg.ok || !/^\d{5,25}$/.test(msg.tweetId)) return;
    if (msg.op === 'DeleteBookmark') {
      send({ type: 'unbookmark', id: msg.tweetId });
    } else if (msg.op === 'CreateBookmark') {
      var rec = cache.get(msg.tweetId) || domRecordById(msg.tweetId);
      if (rec) {
        send({ type: 'ingest', source: 'live', items: [rec] }).then(function (res) {
          if (res) ui.toast(res.added ? '✓ 已收进书签回顾' : '这条已经在书签回顾里了');
        });
      }
    }
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d || d.__xbr !== CH) return;
    try {
      if (d.kind === 'gql') onGql(d);
      else if (d.kind === 'mutation') onMutation(d);
      else if (d.kind === 'bm-status') st.bmStatus = { status: d.status, at: Date.now() };
    } catch (err) {
      /* 解析出错不要影响 X 页面 */
    }
  });

  /* ================= 读页面文字(兜底方案) ================= */
  function textOf(node) {
    var out = '';
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) {
          if (c.tagName === 'IMG') out += c.getAttribute('alt') || ''; // emoji 是图片
          else if (c.tagName === 'BR') out += '\n';
          else walk(c);
        }
      }
    })(node);
    return out;
  }

  // 链接卡片 / X 文章的标题(兜底读法)。标签名是照 X 网页现在的样子写的,读不到就当没有。
  function scrapeCard(art) {
    var at = art.querySelector('[data-testid="twitter-article-title"]');
    if (at && at.textContent.trim()) {
      return { kind: 'article', url: '', title: at.textContent.trim(), desc: '', domain: 'x.com', image: '', w: 0, h: 0 };
    }
    var cw = art.querySelector('[data-testid="card.wrapper"]');
    if (!cw) return null;
    var a = cw.querySelector('a[href]') || (cw.closest && cw.closest('a[href]'));
    var texts = [];
    cw.querySelectorAll('[dir="auto"]').forEach(function (el) {
      var t = (el.textContent || '').trim();
      if (t && texts.indexOf(t) === -1) texts.push(t);
    });
    var domainRe = /^(?:From\s+)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
    var domain = '';
    var rest = [];
    texts.forEach(function (t) {
      if (!domain && domainRe.test(t)) domain = t.replace(/^From\s+/i, '');
      else rest.push(t);
    });
    if (!a || !rest.length) return null;
    var img = cw.querySelector('img');
    return { kind: 'link', url: a.href, title: rest[0], desc: rest.slice(1).join(' ').slice(0, 300), domain: domain, image: img && img.src ? img.src : '', w: 0, h: 0 };
  }

  function scrapeArticle(art) {
    var timeEl = art.querySelector('time');
    var link = timeEl && timeEl.closest('a');
    var m = /^\/([A-Za-z0-9_]+)\/status\/(\d+)/.exec((link && link.getAttribute('href')) || '');
    if (!m) return null;
    var handle = m[1];
    var id = m[2];
    var textEl = art.querySelector('[data-testid="tweetText"]');
    var nameBlock = art.querySelector('[data-testid="User-Name"]');
    var nameLink = nameBlock && nameBlock.querySelector('a[role="link"]');
    var avatar = art.querySelector('[data-testid="Tweet-User-Avatar"] img');
    var media = [];
    art.querySelectorAll('[data-testid="tweetPhoto"] img').forEach(function (img) {
      if (img.src) media.push({ type: 'photo', url: img.src });
    });
    var vid = art.querySelector('[data-testid="videoPlayer"] video');
    if (vid && vid.poster) media.push({ type: 'video', url: vid.poster, video: '' });
    return {
      id: id,
      handle: handle,
      name: (nameLink && textOf(nameLink).trim()) || handle,
      avatar: avatar ? avatar.src : '',
      text: textEl ? textOf(textEl).trim() : '',
      media: media,
      card: scrapeCard(art),
      createdAt: timeEl.getAttribute('datetime') || null,
    };
  }

  function domRecordById(id) {
    var links = document.querySelectorAll('a[href*="/status/' + id + '"]');
    for (var i = 0; i < links.length; i++) {
      var art = links[i].closest('article[data-testid="tweet"]');
      if (art) {
        var rec = scrapeArticle(art);
        if (rec && rec.id === id) return rec;
      }
    }
    return null;
  }

  var domSeen = new Set();
  function scrapeVisible() {
    var out = [];
    document.querySelectorAll('article[data-testid="tweet"]').forEach(function (art) {
      var rec = scrapeArticle(art);
      if (rec && !domSeen.has(rec.id)) {
        domSeen.add(rec.id);
        out.push(rec);
      }
    });
    return out;
  }

  /* ================= 同步任务 ================= */
  var job = { running: false, stop: false };

  function scrollEl() {
    return document.scrollingElement || document.documentElement;
  }
  function atBottom() {
    var e = scrollEl();
    return e.scrollTop + window.innerHeight >= e.scrollHeight - 6;
  }
  function jumpToBottom() {
    window.scrollTo(0, scrollEl().scrollHeight);
  }
  function wiggle() {
    window.scrollBy(0, -Math.round(window.innerHeight * 1.2));
    setTimeout(jumpToBottom, 350);
  }
  function waitUntil(cond, timeoutMs) {
    var t0 = Date.now();
    return (function tick() {
      if (cond()) return Promise.resolve(true);
      if (job.stop || Date.now() - t0 >= timeoutMs) return Promise.resolve(!!cond());
      return sleep(150).then(tick);
    })();
  }
  function hasArticles() {
    return !!document.querySelector('article[data-testid="tweet"]');
  }

  var lastProgressSent = 0;
  function showProgress(base) {
    var n = st.tweets - base.tweets;
    var a = st.added - base.added;
    ui.box({
      title: '正在同步 X 书签',
      msg: '已读取 ' + n + ' 条,新增 ' + a + ' 条\n请先别关这个标签页,读完会自动提示。',
      busy: true,
      buttons: [
        {
          label: '停止',
          onClick: function () {
            job.stop = true;
          },
        },
      ],
    });
    var now = Date.now();
    if (now - lastProgressSent > 1500) {
      lastProgressSent = now;
      send({ type: 'jobProgress', tweets: n, added: a });
    }
  }

  async function countdown(sec, label, base) {
    for (var s = sec; s > 0 && !job.stop; s--) {
      ui.box({
        title: '正在同步 X 书签',
        msg: label + '(' + s + ' 秒后继续)\n已读取 ' + (st.tweets - base.tweets) + ' 条',
        busy: true,
        buttons: [{ label: '停止', onClick: function () { job.stop = true; } }],
      });
      await sleep(1000);
    }
  }

  async function networkLoop(mode, base) {
    var lastPages = st.pages;
    var stalls = 0;
    var rl = 0;
    while (!job.stop) {
      await st.ingests;
      showProgress(base);
      if (st.formatBroken) return 'broken';
      if (st.reachedEnd) return 'end';
      if (mode === 'incremental' && st.knownStreak >= 2) return 'caughtUp';
      var mark = Date.now();
      jumpToBottom();
      var ok = await waitUntil(function () {
        return st.pages > lastPages || st.reachedEnd || st.formatBroken || (st.bmStatus && st.bmStatus.at >= mark);
      }, 9000);
      if (st.bmStatus && st.bmStatus.at >= mark) {
        var s = st.bmStatus.status;
        st.bmStatus = null;
        if (s === 429) {
          if (++rl > 3) return 'ratelimit';
          await countdown(65, '被 X 限速了,先歇一会', base);
          wiggle();
          await sleep(1500);
          continue;
        }
        st.lastHttp = s;
        return 'http';
      }
      if (ok) {
        lastPages = st.pages;
        stalls = 0;
        await sleep(rand(500, 1100)); // 比手动滚动还慢一点,不给 X 添麻烦
      } else {
        if (++stalls >= 3) return 'stalled';
        wiggle();
        await sleep(1200);
      }
    }
    return 'stopped';
  }

  async function domLoop(mode, base) {
    st.usedDom = true;
    var stalls = 0;
    var knownRun = 0;
    window.scrollTo(0, 0);
    await sleep(800);
    while (!job.stop) {
      var recs = scrapeVisible();
      if (recs.length) {
        var res = await send({ type: 'ingest', source: 'dom', items: recs });
        var added = res ? res.added : 0;
        st.tweets += recs.length;
        st.added += added;
        knownRun = added === 0 ? knownRun + recs.length : 0;
        stalls = 0;
        showProgress(base);
      }
      if (mode === 'incremental' && knownRun >= 30) return 'caughtUp';
      var bottom = atBottom();
      window.scrollBy(0, Math.round(window.innerHeight * 0.8));
      await sleep(rand(700, 1200));
      if (!recs.length) {
        stalls++;
        if (bottom && stalls >= 5) return 'end';
        if (stalls >= 25) return 'stalled';
      }
    }
    return 'stopped';
  }

  var OUTCOME_TEXT = {
    end: '已读完整个书签列表。',
    caughtUp: '没有更多新书签了。',
    stopped: '已停止。',
    stalled: '等了很久 X 都没有返回新内容,先停在这里。\n(可以重新同步;页面要保持在前台。)',
    broken: '读不懂 X 返回的数据格式(可能 X 改版了),已改用读取页面文字。',
    ratelimit: 'X 一直在限速,过一会儿再同步吧。',
    http: '',
    nologin: '没有读到书签。请先在 Edge 里登录 X,再重新同步。',
  };

  async function runJob(mode) {
    if (job.running) return;
    job.running = true;
    job.stop = false;
    await domReady();
    // 同步任务总是在一个刚载入的页面里跑(后台会重新载入书签页),所以整个页面生命周期的计数都算这一次。
    // 不能在这里取"当前计数"当起点:第一页数据可能已经到了、但它的入库结果还没回来,会让「读取」比「新增」还少。
    var base = { tweets: 0, added: 0 };
    var outcome = 'nologin';
    ui.box({ title: '正在同步 X 书签', msg: '正在连接…', busy: true, buttons: [{ label: '停止', onClick: function () { job.stop = true; } }] });

    // 等第一页数据(或出错);登录页/空白页会在这里超时
    await waitUntil(function () {
      return st.pages > 0 || st.formatBroken || st.bmStatus;
    }, 20000);

    if (job.stop) outcome = 'stopped';
    else if (st.bmStatus) {
      st.lastHttp = st.bmStatus.status;
      outcome = st.bmStatus.status === 429 ? 'ratelimit' : 'http';
      st.bmStatus = null;
    } else if (st.formatBroken) {
      outcome = 'broken'; // 收到了数据却读不懂(X 改版了)→ 下面退回读页面文字
    } else if (st.pages > 0) {
      outcome = await networkLoop(mode, base);
    }
    // 20 秒都没等到数据,但页面上其实有推文 → 也退回读页面文字
    if (outcome === 'broken' || (st.pages === 0 && hasArticles() && outcome === 'nologin')) {
      // 读页面文字兜底。注意:这条路径的"到头"不可靠,后台不会据此清理已取消的书签(见 usedDom)
      outcome = await domLoop(mode, base);
    }

    await st.ingests;
    var tweets = st.tweets - base.tweets;
    var added = st.added - base.added;
    var summary = { type: 'jobDone', mode: mode, outcome: outcome, tweets: tweets, added: added, usedDom: st.usedDom, syncFrom: PAGE_T0, http: st.lastHttp || 0 };
    var res = await send(summary);

    var ok = outcome === 'end' || outcome === 'caughtUp';
    var text = outcome === 'http' ? 'X 拒绝了请求(状态码 ' + st.lastHttp + ')。\n请确认已登录,稍后再试。' : OUTCOME_TEXT[outcome] || '';
    var head = ok ? '✓ 同步完成' : '同步没有完成';
    var detail = '共读取 ' + tweets + ' 条,新增 ' + added + ' 条。';
    if (res && res.removed) detail += '\n已把 ' + res.removed + ' 条不在 X 书签里的移出回顾池。';
    ui.box({
      title: head,
      msg: (ok ? detail + '\n' + text : text + '\n' + detail).trim(),
      busy: false,
      buttons: [
        { label: '看今日回顾', primary: true, onClick: function () { send({ type: 'openApp' }); } },
        { label: '关闭', onClick: function () { ui.hideBox(); } },
      ],
    });
    job.running = false;
    return summary;
  }

  /* ================= 启动 ================= */
  domReady().then(function () {
    setInterval(function () {
      ui.pill(isBookmarksPath() && !job.running, function () {
        ui.box({ title: '书签回顾', msg: '正在重新载入书签页并开始同步…', busy: true, buttons: [] });
        send({ type: 'syncStart', mode: 'incremental' }).then(function (r) {
          // 成功时后台会重新载入这个标签页,下面的提示随页面一起消失;只有没启动才需要说明原因
          if (r && r.started) return;
          var why = !r ? '没能联系到扩展,请刷新页面再试。' : r.reason === 'running' ? '已经有一个同步在进行了。' : '没能开始同步,请稍后再试。';
          ui.box({ title: '书签回顾', msg: why, buttons: [{ label: '关闭', onClick: function () { ui.hideBox(); } }] });
        });
      });
    }, 800);
  });

  // 后台为这个标签页安排了同步任务?(用户点了「同步」会新开/重载书签页)
  send({ type: 'hello', path: location.pathname }).then(function (r) {
    if (!r || !r.job) return;
    if (r.job.blocked) {
      domReady().then(function () {
        ui.box({
          title: '书签回顾',
          msg: '需要先登录 X。登录后打开「书签」页,点右下角的「同步」按钮。',
          buttons: [{ label: '关闭', onClick: function () { ui.hideBox(); } }],
        });
      });
      return;
    }
    runJob(r.job.mode);
  });
})();
