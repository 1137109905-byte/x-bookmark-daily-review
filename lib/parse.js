/* 把 X 网页自己加载的 GraphQL 数据整理成书签记录。纯函数,不碰浏览器 API。
 *
 * X 的数据结构会不定期改版(比如 2025 年把用户名从 legacy 挪到 core),
 * 所以每个字段都写了多条后备路径,并且只信"形状",不信固定层级。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XBR_PARSE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BOOKMARK_OPS = ['Bookmarks', 'BookmarkSearchTimeline', 'BookmarkFolderTimeline'];

  /** 解析版本。每次改动让「已经存下的书签要重读一遍才有新字段」,就 +1;回顾页据此提示重新同步。
   *  2 = 增加链接卡片 / X 文章的标题(card) */
  const PV = 2;

  /** 从请求地址里取 GraphQL 操作名:/i/api/graphql/<queryId>/<Operation> */
  function opFromUrl(url) {
    const m = /\/i\/api\/graphql\/[^/?#]+\/([A-Za-z0-9_]+)/.exec(String(url || ''));
    return m ? m[1] : '';
  }

  function isBookmarkOp(op) {
    return BOOKMARK_OPS.indexOf(op) !== -1;
  }

  const ENTITY_MAP = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" };
  function unescapeHtml(s) {
    return String(s).replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITY_MAP[m]);
  }

  /* ---------- 雪花 ID → 时间 ---------- */
  const TWEPOCH = 1288834974657n;
  function snowflakeMs(id) {
    try {
      const ms = Number((BigInt(String(id)) >> 22n) + TWEPOCH);
      return Number.isFinite(ms) ? ms : null;
    } catch (_) {
      return null;
    }
  }
  /** 只接受 2006 年以后、明天以前的时间,免得把乱数当日期 */
  function plausibleMs(ms) {
    return typeof ms === 'number' && ms > 1.15e12 && ms < Date.now() + 864e5 ? ms : null;
  }

  /* ---------- 结构兜底 ---------- */
  function unwrapResult(r) {
    let cur = r;
    for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
      if (cur.__typename === 'TweetWithVisibilityResults' && cur.tweet) {
        cur = cur.tweet;
        continue;
      }
      if (!cur.__typename && !cur.rest_id && cur.result && typeof cur.result === 'object') {
        cur = cur.result;
        continue;
      }
      break;
    }
    return cur;
  }

  function userFields(u) {
    u = unwrapResult(u) || {};
    const core = u.core || {};
    const legacy = u.legacy || {};
    const handle = core.screen_name || legacy.screen_name || '';
    return {
      handle,
      name: core.name || legacy.name || handle,
      avatar:
        (u.avatar && u.avatar.image_url) ||
        legacy.profile_image_url_https ||
        core.profile_image_url_https ||
        '',
      verified: !!(u.is_blue_verified || (u.verification && u.verification.verified) || legacy.verified),
    };
  }

  function pickVideo(variants) {
    const mp4 = (variants || [])
      .filter((v) => v && v.content_type === 'video/mp4' && v.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return mp4.length ? mp4[0].url : '';
  }

  function normMedia(list) {
    const out = [];
    for (const m of list || []) {
      if (!m || !m.media_url_https) continue;
      const rec = {
        type: m.type === 'video' || m.type === 'animated_gif' ? m.type : 'photo',
        url: m.media_url_https,
        w: (m.original_info && m.original_info.width) || 0,
        h: (m.original_info && m.original_info.height) || 0,
        alt: m.ext_alt_text || '',
      };
      if (rec.type !== 'photo') rec.video = pickVideo(m.video_info && m.video_info.variants);
      out.push(rec);
    }
    return out;
  }

  /* ---------- 链接卡片 / X 文章(要显示标题,而不是只剩一个链接) ---------- */
  // 卡片数据在 tweet.card.legacy.binding_values(一串 {key, value}),X 长文章在 tweet.article.article_results.result。
  // 两种结构都是照 X 网页现在的样子写的;读不到就当没有卡片,正文里的链接照旧显示。
  function bindingMap(bv) {
    const out = {};
    if (Array.isArray(bv)) {
      for (const e of bv) if (e && typeof e.key === 'string') out[e.key] = e.value;
    } else if (bv && typeof bv === 'object') {
      for (const k of Object.keys(bv)) {
        const v = bv[k];
        out[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
      }
    }
    return out;
  }
  function bvStr(m, k) {
    const v = m[k];
    if (typeof v === 'string') return v;
    return v && typeof v.string_value === 'string' ? v.string_value : '';
  }
  const CARD_IMAGE_KEYS = [
    'photo_image_full_size_large',
    'summary_photo_image_large',
    'thumbnail_image_large',
    'photo_image_full_size_original',
    'summary_photo_image_original',
    'thumbnail_image_original',
    'photo_image_full_size',
    'summary_photo_image',
    'thumbnail_image',
    'player_image_large',
    'player_image',
    'photo_image_full_size_small',
    'summary_photo_image_small',
    'thumbnail_image_small',
  ];
  function bvImage(m) {
    for (const k of CARD_IMAGE_KEYS) {
      const iv = m[k] && m[k].image_value;
      if (iv && typeof iv.url === 'string' && iv.url) return { url: iv.url, w: iv.width | 0, h: iv.height | 0 };
    }
    return null;
  }
  function hostOf(u) {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  }

  function linkCard(t, expand) {
    const c = t.card && t.card.legacy;
    if (!c) return null;
    const m = bindingMap(c.binding_values);
    const title = bvStr(m, 'title').trim();
    if (!title) return null; // 投票、应用安装之类没有标题的卡片不管
    const raw = bvStr(m, 'card_url') || (typeof c.url === 'string' ? c.url : '');
    const url = (raw && expand[raw]) || raw;
    const img = bvImage(m);
    return {
      kind: 'link',
      url: /^https?:\/\//.test(url) ? url : '',
      title,
      desc: bvStr(m, 'description').trim(),
      domain: bvStr(m, 'vanity_url') || bvStr(m, 'domain') || hostOf(url),
      image: img ? img.url : '',
      w: img ? img.w : 0,
      h: img ? img.h : 0,
    };
  }

  function articleCard(t) {
    const a = t.article && t.article.article_results && t.article.article_results.result;
    if (!a || typeof a !== 'object') return null;
    const title = String(a.title || '').trim();
    if (!title) return null;
    const info = a.cover_media && a.cover_media.media_info;
    return {
      kind: 'article',
      url: '', // 点开就去这条帖子(X 会把长文章打开)
      title,
      desc: String(a.preview_text || a.summary_text || '').trim(),
      domain: 'x.com',
      image: (info && typeof info.original_img_url === 'string' && info.original_img_url) || '',
      w: (info && info.original_img_width) | 0,
      h: (info && info.original_img_height) | 0,
    };
  }

  /** 卡片的链接如果就是正文最后一个词,正文里就不再重复它(链接后面还有字的,说明它是正文的一部分,不动) */
  function stripTrailing(text, url) {
    if (!url) return text;
    const i = text.lastIndexOf(url);
    if (i === -1 || text.slice(i + url.length).trim() !== '') return text;
    return text.slice(0, i).replace(/[ \t]+$/gm, '').trim();
  }

  /* ---------- 单条推文 ---------- */
  function normalizeTweet(raw, opts) {
    opts = opts || {};
    const t = unwrapResult(raw);
    if (!t || typeof t !== 'object') return null;
    if (t.__typename && t.__typename !== 'Tweet') return null; // 墓碑(已删除/不可见)等

    const rtRaw = t.legacy && t.legacy.retweeted_status_result && t.legacy.retweeted_status_result.result;
    if (rtRaw) {
      const inner = normalizeTweet(rtRaw, opts);
      if (inner) return inner;
    }

    const legacy = t.legacy;
    if (!legacy || !t.rest_id) return null;
    const id = String(t.rest_id);
    if (!/^\d{5,25}$/.test(id)) return null;

    const author = userFields(t.core && t.core.user_results && t.core.user_results.result);

    const mediaEnt =
      (legacy.extended_entities && legacy.extended_entities.media) ||
      (legacy.entities && legacy.entities.media) ||
      [];

    // 正文:长推文(note_tweet)优先;普通推文按 display_text_range 去掉开头的回复提及和结尾的媒体链接
    const note = t.note_tweet && t.note_tweet.note_tweet_results && t.note_tweet.note_tweet_results.result;
    let text;
    let urls;
    if (note && typeof note.text === 'string' && note.text) {
      text = note.text;
      urls = (note.entity_set && note.entity_set.urls) || [];
    } else {
      const full = String(legacy.full_text || '');
      text = full;
      const range = legacy.display_text_range;
      if (Array.isArray(range) && range.length === 2) {
        const cps = Array.from(full); // 范围按 Unicode 码点算,不是 UTF-16 单元
        const a = Math.max(0, range[0] | 0);
        const b = Math.min(cps.length, range[1] | 0);
        if (b > a) text = cps.slice(a, b).join('');
      }
      text = unescapeHtml(text);
      urls = (legacy.entities && legacy.entities.urls) || [];
    }
    const expand = {}; // t.co 短链 → 真实链接
    for (const u of urls) {
      if (u && u.url && u.expanded_url) {
        expand[u.url] = u.expanded_url;
        text = text.split(u.url).join(u.expanded_url);
      }
    }
    for (const m of mediaEnt) if (m && m.url) text = text.split(m.url).join('');
    if (legacy.quoted_status_permalink && legacy.quoted_status_permalink.url) {
      text = text.split(legacy.quoted_status_permalink.url).join('');
    }
    text = text.replace(/[ \t]+$/gm, '').trim();

    // 链接卡片 / X 长文章:标题交给卡片显示,正文末尾那个重复的链接去掉
    let card = null;
    if (!opts.noQuote) {
      card = articleCard(t) || linkCard(t, expand);
      if (card) {
        if (card.kind === 'article') {
          for (const u of urls) {
            const e = u && u.expanded_url;
            if (e && /(?:^|\/\/)(?:www\.)?(?:x|twitter)\.com\/(?:i\/article\/|[A-Za-z0-9_]+\/article\/)\d+/.test(e)) text = stripTrailing(text, e);
          }
        } else {
          text = stripTrailing(text, card.url);
        }
        text = text.replace(/\s*https:\/\/t\.co\/\w+\s*$/, '').trim(); // 没来得及展开的短链
      }
    }

    let quoted = null;
    if (!opts.noQuote) {
      const q = t.quoted_status_result && t.quoted_status_result.result;
      const qn = q ? normalizeTweet(q, { noQuote: true }) : null;
      if (qn) {
        quoted = { id: qn.id, handle: qn.handle, name: qn.name, text: qn.text, url: qn.url, media: qn.media.slice(0, 1) };
      }
    }

    let ts = Date.parse(legacy.created_at || '');
    if (!Number.isFinite(ts)) ts = snowflakeMs(id);
    const createdAt = plausibleMs(ts) ? new Date(ts).toISOString() : null;

    return {
      id,
      url: author.handle ? 'https://x.com/' + author.handle + '/status/' + id : 'https://x.com/i/web/status/' + id,
      handle: author.handle,
      name: author.name,
      avatar: author.avatar,
      verified: author.verified,
      text,
      media: normMedia(mediaEnt),
      card,
      quoted,
      replyTo: legacy.in_reply_to_screen_name || '',
      lang: legacy.lang || '',
      createdAt,
    };
  }

  /* ---------- 书签时间线 ---------- */
  function collectInstructions(node, acc, depth) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 8) return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (k === 'instructions' && Array.isArray(v)) {
        for (const ins of v) acc.push(ins);
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        collectInstructions(v, acc, depth + 1);
      }
    }
  }

  /**
   * 解析一页书签响应。
   * 返回 { items, cursorBottom, cursorTop, tweetEntries, unavailable }
   * tweetEntries === 0 表示这一页没有任何推文条目 → 列表到头了。
   */
  function parseTimeline(json) {
    const out = { items: [], cursorBottom: null, cursorTop: null, tweetEntries: 0, unavailable: 0 };
    const instr = [];
    collectInstructions(json, instr, 0);
    const seen = new Set();

    function handleEntry(e) {
      const c = e && e.content;
      if (!c) return;
      if (c.cursorType || c.entryType === 'TimelineTimelineCursor') {
        if (/bottom/i.test(c.cursorType || '')) out.cursorBottom = c.value || null;
        else if (/top/i.test(c.cursorType || '')) out.cursorTop = c.value || null;
        return;
      }
      const contents = [];
      if (c.itemContent) contents.push(c.itemContent);
      if (Array.isArray(c.items)) {
        for (const it of c.items) {
          const ic = it && ((it.item && it.item.itemContent) || it.itemContent);
          if (ic) contents.push(ic);
        }
      }
      for (const ic of contents) {
        const tr = ic && ic.tweet_results && ic.tweet_results.result;
        if (!tr) continue;
        out.tweetEntries++;
        const rec = normalizeTweet(tr);
        if (!rec) {
          out.unavailable++;
          continue;
        }
        if (seen.has(rec.id)) continue;
        seen.add(rec.id);
        rec.sortIndex = e.sortIndex ? String(e.sortIndex) : null;
        out.items.push(rec);
      }
    }

    for (const ins of instr) {
      if (!ins) continue;
      if (Array.isArray(ins.entries)) ins.entries.forEach(handleEntry);
      else if (ins.entry) handleEntry(ins.entry);
    }
    return out;
  }

  /** 在任意 GraphQL 响应里找出所有推文(给"实时收藏"做缓存用) */
  function parseAnyTweets(json, maxNodes) {
    maxNodes = maxNodes || 400000;
    const out = [];
    const seen = new Set();
    const stack = [json];
    let visited = 0;
    while (stack.length && visited++ < maxNodes) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        continue;
      }
      if (
        (node.__typename === 'Tweet' && node.rest_id && node.legacy) ||
        (node.__typename === 'TweetWithVisibilityResults' && node.tweet)
      ) {
        const rec = normalizeTweet(node);
        if (rec && !seen.has(rec.id)) {
          seen.add(rec.id);
          out.push(rec);
        }
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return out;
  }

  /* ---------- 入库前清洗(内容脚本传来的都当作不可信输入) ---------- */
  function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }
  function num(v) {
    return Number.isFinite(v) ? v : 0;
  }
  function cdnUrl(v) {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && /(^|\.)(twimg\.com|x\.com|twitter\.com)$/.test(u.hostname) ? u.href : '';
    } catch (_) {
      return '';
    }
  }
  function isoOrNull(v) {
    const ms = Date.parse(v || '');
    return plausibleMs(ms) ? new Date(ms).toISOString() : null;
  }
  /** 卡片的跳转链接:只认 http(s)(外部网站可以是任何域名,但绝不能是 javascript: 之类) */
  function httpUrl(v) {
    try {
      const u = new URL(v);
      return (u.protocol === 'https:' || u.protocol === 'http:') && u.href.length <= 2000 ? u.href : '';
    } catch (_) {
      return '';
    }
  }
  function sanitizeCard(c) {
    if (!c || typeof c !== 'object') return null;
    const title = str(c.title, 300).trim();
    if (!title) return null; // 没有标题就不算卡片
    return {
      kind: c.kind === 'article' ? 'article' : 'link',
      url: httpUrl(c.url),
      title,
      desc: str(c.desc, 600).trim(),
      domain: str(c.domain, 120),
      image: cdnUrl(c.image),
      w: num(c.w),
      h: num(c.h),
    };
  }

  function sanitizeItem(r) {
    if (!r || typeof r !== 'object') return null;
    const id = String(r.id || '');
    if (!/^\d{5,25}$/.test(id)) return null;
    const handle = str(r.handle, 40).replace(/[^A-Za-z0-9_]/g, '');
    const media = (Array.isArray(r.media) ? r.media : [])
      .slice(0, 8)
      .map((m) => ({
        type: m && (m.type === 'video' || m.type === 'animated_gif') ? m.type : 'photo',
        url: cdnUrl(m && m.url),
        video: cdnUrl(m && m.video),
        w: num(m && m.w),
        h: num(m && m.h),
        alt: str(m && m.alt, 500),
      }))
      .filter((m) => m.url);
    let quoted = null;
    if (r.quoted && typeof r.quoted === 'object' && /^\d{5,25}$/.test(String(r.quoted.id || ''))) {
      const qh = str(r.quoted.handle, 40).replace(/[^A-Za-z0-9_]/g, '');
      const qid = String(r.quoted.id);
      quoted = {
        id: qid,
        handle: qh,
        name: str(r.quoted.name, 80) || qh,
        text: str(r.quoted.text, 5000),
        url: qh ? 'https://x.com/' + qh + '/status/' + qid : 'https://x.com/i/web/status/' + qid,
        media: (Array.isArray(r.quoted.media) ? r.quoted.media : [])
          .slice(0, 1)
          .map((m) => ({ type: 'photo', url: cdnUrl(m && m.url), video: '', w: 0, h: 0, alt: '' }))
          .filter((m) => m.url),
      };
    }
    return {
      id,
      url: handle ? 'https://x.com/' + handle + '/status/' + id : 'https://x.com/i/web/status/' + id,
      handle,
      name: str(r.name, 80) || handle,
      avatar: cdnUrl(r.avatar),
      verified: !!r.verified,
      text: str(r.text, 30000),
      media,
      card: sanitizeCard(r.card),
      quoted,
      replyTo: str(r.replyTo, 40).replace(/[^A-Za-z0-9_]/g, ''),
      lang: str(r.lang, 12),
      createdAt: isoOrNull(r.createdAt),
      sortIndex: /^\d{5,25}$/.test(String(r.sortIndex || '')) ? String(r.sortIndex) : null,
    };
  }

  return {
    BOOKMARK_OPS,
    PV,
    opFromUrl,
    isBookmarkOp,
    unescapeHtml,
    snowflakeMs,
    plausibleMs,
    normalizeTweet,
    parseTimeline,
    parseAnyTweets,
    sanitizeItem,
    cdnUrl,
  };
});
