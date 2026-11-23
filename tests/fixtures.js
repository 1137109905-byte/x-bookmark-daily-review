'use strict';
/* 造 X 风格的 GraphQL 数据,单元测试和模拟 X 服务器共用。
 * 全是虚构账号和内容,不涉及真实人物。 */

const TWEPOCH = 1288834974657n;
function snowflakeFromMs(ms, seq = 0) {
  return ((BigInt(ms) - TWEPOCH) << 22n | BigInt(seq)).toString();
}

function userResult({ handle, name, schema = 'new', id = '1000' }) {
  const avatar = 'https://pbs.twimg.com/profile_images/' + id + '/a_normal.jpg';
  if (schema === 'old') {
    return {
      __typename: 'User',
      rest_id: id,
      is_blue_verified: false,
      legacy: { screen_name: handle, name, profile_image_url_https: avatar },
    };
  }
  // 2025 年以后的新结构:名字在 core,头像在 avatar
  return {
    __typename: 'User',
    rest_id: id,
    is_blue_verified: true,
    core: { screen_name: handle, name, created_at: 'Mon Jan 01 00:00:00 +0000 2018' },
    avatar: { image_url: avatar },
    legacy: { description: '示例简介' },
  };
}

function photo(n, id) {
  return {
    type: 'photo',
    url: 'https://t.co/pho' + n,
    media_url_https: 'https://pbs.twimg.com/media/' + id + n + '.jpg',
    original_info: { width: 1200, height: 800 },
    ext_alt_text: n === 1 ? '示例图片' : undefined,
  };
}

/** 造一条推文结果。选项见下方解构。 */
function tweetResult(o) {
  const {
    id,
    handle = 'demo_user',
    name = '示例用户',
    text = '示例内容',
    schema = 'new',
    createdAt = 'Wed Oct 10 20:19:24 +0000 2018',
    photos = 0,
    video = false,
    gif = false,
    quoted = null,
    long = '',
    wrap = false,
    reply = '',
    urls = [],
    quotePermalink = '',
    photoId = 'IMG',
  } = o;

  let full = text;
  let range = [0, Array.from(full).length];
  if (reply) {
    full = '@' + reply + ' ' + text;
    range = [reply.length + 2, Array.from(full).length];
  }
  const media = [];
  for (let i = 1; i <= photos; i++) media.push(photo(i, photoId));
  if (video) {
    media.push({
      type: 'video',
      url: 'https://t.co/vid1',
      media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/v1.jpg',
      original_info: { width: 1280, height: 720 },
      video_info: {
        variants: [
          { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/1/pu/pl/a.m3u8' },
          { bitrate: 632000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/480x270/low.mp4' },
          { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/high.mp4' },
        ],
      },
    });
  }
  if (gif) {
    media.push({
      type: 'animated_gif',
      url: 'https://t.co/gif1',
      media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/g1.jpg',
      video_info: { variants: [{ bitrate: 0, content_type: 'video/mp4', url: 'https://video.twimg.com/tweet_video/g1.mp4' }] },
    });
  }
  // 媒体的 t.co 链接会出现在 full_text 末尾,但在 display_text_range 之外
  if (media.length) {
    const tail = media.map((m) => m.url).join(' ');
    full = full + ' ' + tail;
  }
  if (quotePermalink) full = full + ' ' + quotePermalink;

  const legacy = {
    created_at: createdAt,
    full_text: full,
    lang: 'zh',
    display_text_range: range,
    entities: { urls, user_mentions: [] },
  };
  if (media.length) {
    legacy.entities.media = [media[0]];
    legacy.extended_entities = { media };
  }
  if (reply) legacy.in_reply_to_screen_name = reply;
  if (quotePermalink) legacy.quoted_status_permalink = { url: quotePermalink, expanded: 'https://x.com/i/status/1', display: 'x.com/i/status/1' };

  const t = {
    __typename: 'Tweet',
    rest_id: String(id),
    core: { user_results: { result: userResult({ handle, name, schema }) } },
    legacy,
  };
  if (long) {
    t.note_tweet = { is_expandable: true, note_tweet_results: { result: { id: 'n' + id, text: long, entity_set: { urls: [] } } } };
  }
  if (quoted) t.quoted_status_result = { result: quoted };
  return wrap ? { __typename: 'TweetWithVisibilityResults', tweet: t } : t;
}

function tombstone() {
  return { __typename: 'TweetTombstone', tombstone: { text: { text: '这条帖子已被删除' } } };
}

function entryOf(result, sortIndex) {
  const inner = result.tweet || result;
  const id = inner.rest_id || 'x';
  return {
    entryId: 'tweet-' + id,
    sortIndex: String(sortIndex),
    content: {
      entryType: 'TimelineTimelineItem',
      __typename: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineTweet',
        __typename: 'TimelineTweet',
        tweet_results: { result },
      },
    },
  };
}

function cursorEntry(type, value) {
  return {
    entryId: 'cursor-' + type.toLowerCase() + '-' + value,
    sortIndex: type === 'Bottom' ? '0' : '9',
    content: { entryType: 'TimelineTimelineCursor', __typename: 'TimelineTimelineCursor', value, cursorType: type },
  };
}

/** results: [{ result, sortIndex }];bottom 为空表示没有下一页 */
function bookmarksResponse(results, bottom) {
  const entries = results.map((r) => entryOf(r.result, r.sortIndex));
  if (bottom) entries.push(cursorEntry('Bottom', bottom));
  entries.push(cursorEntry('Top', 'top-1'));
  return {
    data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } },
  };
}

/** 首页时间线(用来测"实时收藏"):里面的推文没有书签身份,只是普通时间线 */
function homeResponse(results) {
  const entries = results.map((r, i) => entryOf(r, 1000 - i));
  return {
    data: { home: { home_timeline_urt: { instructions: [{ type: 'TimelineAddEntries', entries }] } } },
  };
}

module.exports = {
  snowflakeFromMs,
  userResult,
  tweetResult,
  tombstone,
  entryOf,
  cursorEntry,
  bookmarksResponse,
  homeResponse,
};
