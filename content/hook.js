/* 运行在 X 页面自己的环境里(MAIN world),只做一件事:
 * 旁听 X 网页发给自己服务器的 GraphQL 请求,把「书签列表」「收藏 / 取消收藏」的结果转交给扩展。
 * 不修改任何请求和响应,不向任何第三方发送数据。 */
(function () {
  'use strict';
  if (window.__xbrHook) return;
  try {
    Object.defineProperty(window, '__xbrHook', { value: true });
  } catch (_) {
    return;
  }

  var CH = 'xbr:v1';
  var GQL = /\/i\/api\/graphql\/[^/?#]+\/([A-Za-z0-9_]+)/;
  var BM_OPS = { Bookmarks: 1, BookmarkSearchTimeline: 1, BookmarkFolderTimeline: 1 };
  var MUT_OPS = { CreateBookmark: 1, DeleteBookmark: 1 };
  // 其它带推文的时间线(首页、详情页、搜索……):只用来做"实时收藏"的内存缓存
  var TWEET_OPS = /Timeline|TweetDetail|TweetResultBy|UserTweets|UserMedia|Search|Likes|Home|Highlights|Community|ListLatest/;
  var MAX_BODY = 12 * 1024 * 1024;

  function post(msg) {
    try {
      var m = { __xbr: CH };
      for (var k in msg) m[k] = msg[k];
      window.postMessage(m, window.location.origin);
    } catch (_) {}
  }

  function onMutation(op, reqBody, status) {
    var id = '';
    try {
      var j = JSON.parse(reqBody);
      id = String((j.variables && j.variables.tweet_id) || '');
    } catch (_) {}
    if (id) post({ kind: 'mutation', op: op, tweetId: id, ok: status >= 200 && status < 300 });
  }

  function onText(op, status, text) {
    if (typeof text !== 'string') return;
    if (BM_OPS[op]) {
      post({ kind: 'gql', op: op, text: text });
      return;
    }
    if (status === 200 && text.length < MAX_BODY && text.indexOf('"full_text"') !== -1) {
      post({ kind: 'gql', op: op, text: text });
    }
  }

  /* ---------- fetch ---------- */
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var p = origFetch.apply(this, arguments);
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || String(input);
        var m = GQL.exec(url);
        if (m) {
          var op = m[1];
          var reqBody = init && typeof init.body === 'string' ? init.body : null;
          p.then(
            function (res) {
              try {
                if (MUT_OPS[op]) {
                  if (reqBody) onMutation(op, reqBody, res.status);
                  return;
                }
                if (BM_OPS[op] && res.status !== 200) {
                  post({ kind: 'bm-status', op: op, status: res.status });
                  return;
                }
                if (!BM_OPS[op] && !TWEET_OPS.test(op)) return;
                res.clone().text().then(
                  function (t) {
                    onText(op, res.status, t);
                  },
                  function () {}
                );
              } catch (_) {}
            },
            function () {}
          );
        }
      } catch (_) {}
      return p; // 原样返回,页面拿到的 Promise 和没装扩展时一模一样
    };
  }

  /* ---------- XMLHttpRequest(老路径,留个保险) ---------- */
  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__xbrUrl = String(url);
    } catch (_) {}
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      var url = this.__xbrUrl;
      var m = url && GQL.exec(url);
      if (m) {
        var op = m[1];
        var b = typeof body === 'string' ? body : null;
        var xhr = this;
        xhr.addEventListener('loadend', function () {
          try {
            if (MUT_OPS[op]) {
              if (b) onMutation(op, b, xhr.status);
              return;
            }
            if (BM_OPS[op] && xhr.status !== 200) {
              post({ kind: 'bm-status', op: op, status: xhr.status });
              return;
            }
            if (!BM_OPS[op] && !TWEET_OPS.test(op)) return;
            var text = xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : null;
            if (text) onText(op, xhr.status, text);
          } catch (_) {}
        });
      }
    } catch (_) {}
    return XS.apply(this, arguments);
  };
})();
