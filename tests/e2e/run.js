'use strict';
/* 端到端实测:带着本扩展启动 Chrome for Testing,把 x.com 指到本地的模拟服务器,
 * 真的跑一遍「同步 → 每日抽取 → 回顾页 → 实时收藏 → 换日 → 提醒 → 备份 → X 改版兜底 → 出错」。
 *
 * 用法:  node tests/e2e/run.js
 * 环境变量(都可选):
 *   XBR_E2E_CHROME  带扩展支持的 Chromium 路径(默认用 Playwright 缓存里的 Chrome for Testing)
 *   XBR_E2E_TMP     临时目录(证书、浏览器配置、截图都放这里)
 *   XBR_E2E_SHOTS   截图输出目录
 * 说明:新版 Chrome/Edge 正式版已不允许命令行加载扩展,所以用 Chrome for Testing。
 * 全程只连本机,不会碰真正的 X,也不会碰你的浏览器资料。 */
const { spawn, execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-x.js');

const EXT = path.resolve(__dirname, '..', '..');
const CHROME =
  process.env.XBR_E2E_CHROME ||
  path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const WORK = fs.mkdtempSync(path.join(process.env.XBR_E2E_TMP || os.tmpdir(), 'xbr-e2e-'));
const SHOTS = process.env.XBR_E2E_SHOTS || path.join(WORK, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, every, what) {
  const t0 = Date.now();
  let lastErr = null;
  for (;;) {
    let v = null;
    try {
      v = await fn();
    } catch (e) {
      lastErr = e;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时:' + (what || '条件') + (lastErr ? '(最近一次错误:' + lastErr.message + ')' : ''));
    await sleep(every || 300);
  }
}

/* ---------- 最小的 CDP 客户端(Node 22 自带 WebSocket) ---------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          if (m.error) p.rej(new Error(m.error.message));
          else p.res(m.result);
        }
      } else {
        for (const h of this.handlers) h(m);
      }
    };
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(fn) {
    this.handlers.push(fn);
  }
}

let passed = 0;
let onFail = async () => {}; // 浏览器起来之后换成「打印失败现场」
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
  } catch (e) {
    console.log('  ✗ ' + name + '\n      ' + String(e.stack || e.message).split('\n').slice(0, 9).join('\n      '));
    await onFail().catch((err) => console.log('  (打印失败现场时出错:' + err.message + ')'));
    throw new Error('步骤失败:' + name);
  }
}

async function main() {
  console.log('工作目录:' + WORK);

  /* ---- 自签证书 + 模拟 X ---- */
  const keyFile = path.join(WORK, 'key.pem');
  const certFile = path.join(WORK, 'cert.pem');
  const conf = path.join(WORK, 'openssl.cnf');
  fs.writeFileSync(
    conf,
    '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=x.com\n[v3]\nsubjectAltName=DNS:x.com,DNS:twitter.com,DNS:pbs.twimg.com,DNS:video.twimg.com\n'
  );
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2', '-config', conf], { stdio: 'ignore' });
  // 一段 3 秒的小视频,让「模拟 X」当作推文里的视频发出去(本机没有 ffmpeg 就跳过视频播放那一项)
  let videoFile = null;
  try {
    const out = path.join(WORK, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=480x270:rate=24', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', out], { stdio: 'ignore' });
    videoFile = out;
  } catch (_) {}
  const mock = await startMock({ keyFile, certFile, videoFile });
  const PORT = mock.port;
  const ctl = (p) =>
    new Promise((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port: PORT, path: p, rejectUnauthorized: false }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(b));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on('error', reject);
    });

  /* ---- 启动浏览器 ---- */
  const profile = path.join(WORK, 'profile');
  const rules = ['x.com', 'twitter.com', 'pbs.twimg.com', 'video.twimg.com'].map((h) => 'MAP ' + h + ' 127.0.0.1:' + PORT).join(',');
  const chrome = spawn(
    CHROME,
    [
      '--user-data-dir=' + profile,
      '--remote-debugging-port=0',
      '--load-extension=' + EXT,
      '--disable-extensions-except=' + EXT,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      '--password-store=basic',
      '--ignore-certificate-errors',
      '--no-proxy-server', // 本机常有系统代理,不关的话 x.com 会绕过本地模拟服务器、真的发给代理
      '--window-size=1200,900',
      '--host-resolver-rules=' + rules,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').includes('/devtools/browser/'), 25000, 200, '浏览器启动');
    const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    const ws = new WebSocket('ws://127.0.0.1:' + port + wsPath);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('连不上浏览器调试端口'));
    });
    const cdp = new CDP(ws);

    const problems = []; // 未捕获异常 / console.error
    const logs = []; // 最近的控制台输出(各页面和后台),失败时打印出来帮助定位
    const argText = (m) => m.params.args.map((a) => (a.value !== undefined ? a.value : a.description)).join(' ');
    cdp.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
        problems.push({ session: m.sessionId, text });
        logs.push('[异常 ' + String(m.sessionId).slice(0, 4) + '] ' + String(text).slice(0, 300));
      } else if (m.method === 'Runtime.consoleAPICalled') {
        if (m.params.type === 'error') problems.push({ session: m.sessionId, text: argText(m) });
        logs.push('[' + m.params.type + ' ' + String(m.sessionId).slice(0, 4) + '] ' + String(argText(m)).slice(0, 300));
      } else if (m.method === 'Network.loadingFailed') {
        logs.push('[网络失败 ' + String(m.sessionId).slice(0, 4) + '] ' + m.params.errorText + ' ' + (m.params.blockedReason || ''));
      }
      if (logs.length > 300) logs.splice(0, logs.length - 300);
    });

    const targets = async () => (await cdp.send('Target.getTargets')).targetInfos;
    const attach = async (targetId) => (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    async function evalIn(sid, expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
      return r.result.value;
    }
    async function openPage(url, o) {
      o = o || {};
      const { targetId } = await cdp.send('Target.createTarget', { url });
      const sid = await attach(targetId);
      await cdp.send('Runtime.enable', {}, sid);
      await cdp.send('Page.enable', {}, sid);
      if (o.width) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height || 900, deviceScaleFactor: o.dsf || 2, mobile: false }, sid);
      }
      if (o.dark) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sid);
      return { targetId, sid };
    }
    async function shot(sid, file, o) {
      o = o || {};
      const params = { format: 'png', fromSurface: true };
      if (o.full) {
        const m = await cdp.send('Page.getLayoutMetrics', {}, sid);
        // cssContentSize.width 会比视口窄一条滚动条(15px),直接拿来裁会把右边切掉一截
        const vw = await evalIn(sid, 'window.innerWidth');
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width: Math.max(Math.ceil(m.cssContentSize.width), vw), height: Math.min(Math.ceil(m.cssContentSize.height), o.maxH || 5200), scale: 1 };
      }
      const r = await cdp.send('Page.captureScreenshot', params, sid);
      fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
    }

    let extId = '';
    let drv = '';
    const D = (body) => evalIn(drv, '(async () => { const DB = self.XBR_DB; ' + body + ' })()');
    const rpcRaw = (type, payload) => D('return await chrome.runtime.sendMessage(' + JSON.stringify(Object.assign({ type }, payload || {})) + ');');
    const rpc = async (type, payload) => {
      const r = await rpcRaw(type, payload);
      if (!r || !r.ok) throw new Error('rpc ' + type + ' 失败:' + JSON.stringify(r));
      return r.data;
    };
    const allItems = () => D('return await DB.getAll("items");');
    const shownSum = () => D('const a = await DB.getAll("items"); return a.reduce((s, i) => s + (i.shownCount | 0), 0);');
    const getPlan = () => D('return await DB.kvGet("plan");');
    const cardIds = (sid) => evalIn(sid, "[...document.querySelectorAll('#view-today .card')].map(c => c.dataset.id)");
    const xTabs = async () => (await targets()).filter((t) => t.type === 'page' && /^https:\/\/x\.com\//.test(t.url));

    async function runSync(mode) {
      const before = await D('const s = await DB.kvGet("sync"); return (s && s.lastRunAt) || 0;');
      const r = await rpc('syncStart', { mode });
      assert.equal(r.started, true, '同步应当启动');
      return syncAfter(before);
    }
    async function syncAfter(before) {
      const s = await waitFor(() => D('const s = await DB.kvGet("sync"); return s && s.lastRunAt > ' + before + ' ? s : null;'), 90000, 500, '同步结束');
      assert.ok(s.lastTweets >= s.lastAdded, '「读取」条数不应少于「新增」条数:读取 ' + s.lastTweets + ',新增 ' + s.lastAdded);
      return s;
    }
    const lastRunAt = () => D('const s = await DB.kvGet("sync"); return (s && s.lastRunAt) || 0;');
    // 页面里的图片是懒加载的(真人往下滚才会载入)。截图前让它们一次载完,否则长页面下半截是空的。
    async function imagesReady(sid, scope) {
      await evalIn(sid, "document.querySelectorAll('" + scope + " img').forEach((i) => { i.loading = 'eager'; })");
      try {
        await waitFor(() => evalIn(sid, "[...document.querySelectorAll('" + scope + " img')].every((i) => i.complete)"), 15000, 250, '图片加载完');
      } catch (e) {
        const bad = await evalIn(sid, "[...document.querySelectorAll('" + scope + " img')].filter((i) => !i.complete).map((i) => i.src.slice(0, 90))");
        throw new Error(e.message + ';未加载 ' + bad.length + ' 张,例如 ' + JSON.stringify(bad.slice(0, 3)));
      }
    }
    async function appReady(sid, n) {
      await waitFor(async () => (await cardIds(sid)).length === n, 15000, 250, '今日卡片渲染(' + n + ' 张)');
      await imagesReady(sid, '#view-today');
    }
    // 预览图:页面顶部一屏,再滚到第一张带图片/视频的卡片再来一屏(计划是随机抽的,所以按内容找)
    async function showcase(sid, prefix) {
      await evalIn(sid, 'window.scrollTo(0, 0)');
      await shot(sid, prefix + '-顶部.png');
      const has = await evalIn(sid, "(() => { const m = document.querySelector('#view-today .card .media'); if (!m) return false; m.closest('.card').scrollIntoView({ block: 'start' }); window.scrollBy(0, -90); return true; })()");
      if (has) {
        await sleep(300);
        await shot(sid, prefix + '-图片视频.png');
      }
      await evalIn(sid, 'window.scrollTo(0, 0)');
    }

    onFail = async () => {
      console.log('\n      —— 失败现场 ——');
      const ts = await targets();
      for (const t of ts.filter((x) => x.type === 'page' || (x.type === 'service_worker' && x.url.includes(extId)))) {
        console.log('      [' + t.type + '] ' + t.url.slice(0, 100) + '  ' + (t.title || '').slice(0, 30));
      }
      try {
        console.log('      同步状态:' + JSON.stringify(await D('return await DB.kvGet("sync");')));
        console.log('      后台任务表:' + JSON.stringify(await D('return await chrome.storage.session.get("jobs");')));
      } catch (e) {
        console.log('      (读同步状态失败:' + e.message + ')');
      }
      try {
        console.log('      模拟 X 统计:' + JSON.stringify(await ctl('/__test/stats')));
      } catch (e) {}
      for (const t of ts.filter((x) => x.type === 'page' && /^https:\/\/x\.com\//.test(x.url))) {
        try {
          const s = await attach(t.targetId);
          const info = await evalIn(
            s,
            '({ href: location.href, title: document.title, ready: document.readyState, articles: document.querySelectorAll("article").length, scrollH: document.documentElement.scrollHeight, hook: !!window.__xbrHook, host: !!document.querySelector("[data-xbr]"), text: document.body ? document.body.innerText.slice(0, 160) : "" })'
          );
          console.log('      X 页面:' + JSON.stringify(info));
        } catch (e) {
          console.log('      (读 X 页面失败:' + e.message + ')');
        }
      }
      console.log('      最近的控制台输出(新的在下):');
      for (const l of logs.slice(-30)) console.log('        ' + l);
    };

    console.log('\n端到端实测');
    let today = '';

    /* ============================ 装载与首次打开 ============================ */
    await step('扩展装载成功,后台已启动', async () => {
      // Chrome for Testing 自带几个内置扩展(也有后台脚本),所以要按名字认出「我们的」那个
      const sw = await waitFor(
        async () => {
          for (const t of (await targets()).filter((x) => x.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js/.test(x.url))) {
            const s = await attach(t.targetId);
            let name = '';
            try {
              name = await evalIn(s, 'chrome.runtime.getManifest().name');
            } catch (_) {}
            if (name === 'X 书签每日回顾') return { target: t, sid: s };
            await cdp.send('Target.detachFromTarget', { sessionId: s }).catch(() => {});
          }
          return null;
        },
        25000,
        400,
        '扩展后台启动(扩展没装上?)'
      );
      extId = new URL(sw.target.url).host;
      const swSid = sw.sid;
      await cdp.send('Runtime.enable', {}, swSid);
      const t = await cdp.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/tests/e2e/driver.html' });
      drv = await attach(t.targetId);
      await cdp.send('Runtime.enable', {}, drv);
      await waitFor(() => evalIn(drv, 'typeof self.XBR_DB === "object" && typeof chrome.runtime.sendMessage === "function"'), 10000, 200, 'driver 页就绪');
      assert.equal(await D('return chrome.runtime.getManifest().name;'), 'X 书签每日回顾');
      today = await D('return self.XBR_PLAN.dayKey();');
    });

    await step('装好后自动打开了回顾页(首次引导)', async () => {
      const t = await waitFor(async () => (await targets()).find((x) => x.type === 'page' && x.url.startsWith('chrome-extension://' + extId + '/app.html')), 10000, 300, '安装后自动打开回顾页');
      // 顺手挂上去听它有没有报错;测完关掉,免得后面的页面抢「当前标签页」
      const s = await attach(t.targetId);
      await cdp.send('Runtime.enable', {}, s);
      await sleep(500);
      await cdp.send('Target.closeTarget', { targetId: t.targetId });
    });

    await step('空状态:书签池为空,没有卡片', async () => {
      const st = await rpc('state', { view: false });
      assert.equal(st.counts.total, 0);
      assert.equal(st.items.length, 0);
      const p = await openPage('chrome-extension://' + extId + '/app.html#today', { width: 920, height: 900 });
      await waitFor(() => evalIn(p.sid, "!!document.querySelector('#view-today .empty .btn-primary')"), 10000, 250, '首次引导界面');
      await shot(p.sid, '01-首次打开.png');
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
    });

    /* ============================ 首次完整同步 ============================ */
    let N = 0;
    await step('首次同步:自动开页、滚动、读完全部书签(含长帖/图/视频/引用/墓碑)', async () => {
      await ctl('/__test/stats?reset=1');
      const started = await rpc('syncStart', { mode: 'full' });
      assert.equal(started.started, true);
      assert.equal(started.createdByUs, true, '没有现成的书签页,应当新开一个标签页');
      const again = await rpc('syncStart', { mode: 'full' });
      assert.equal(again.started, false, '同步进行中再点,不应重复开');
      assert.equal(again.reason, 'running');

      const xt = await waitFor(async () => (await xTabs()).find((t) => t.url.startsWith('https://x.com/i/bookmarks')), 15000, 200, 'X 书签页被打开');
      const xs = await attach(xt.targetId);
      await cdp.send('Page.enable', {}, xs);
      await cdp.send('Runtime.enable', {}, xs);
      await cdp.send('Network.enable', {}, xs);
      await sleep(1600);
      await shot(xs, '10-同步中-页面右下角提示.png').catch(() => {});

      const sync = await waitFor(() => D('const s = await DB.kvGet("sync"); return s && s.lastRunAt ? s : null;'), 90000, 500, '同步结束');
      await shot(xs, '11-同步完成-页面右下角提示.png').catch(() => {});
      assert.equal(sync.lastOutcome, 'end');
      assert.equal(sync.lastMode, 'full');
      assert.equal(sync.lastTweets, 87, '「读取」条数应是 87(曾因起点取错少算成 68)');
      assert.equal(sync.lastAdded, 87);

      const items = await allItems();
      assert.equal(items.length, 87, '90 条里 3 条是已删除的墓碑,应读到 87 条');
      assert.ok(items.every((i) => /^\d+$/.test(i.id) && i.source === 'bookmarks' && i.url.startsWith('https://x.com/')), '基本字段');
      assert.ok(items.every((i) => typeof i.bookmarkedAt === 'number'), '收藏时间来自 sortIndex');
      assert.ok(items.some((i) => i.media.some((m) => m.type === 'photo')), '读到了图片');
      assert.ok(items.some((i) => i.media.some((m) => m.type === 'video' && /\.mp4$/.test(m.video))), '读到了视频(取 mp4)');
      assert.ok(items.some((i) => i.quoted && i.quoted.text.includes('被引用')), '读到了引用推文');
      assert.ok(items.some((i) => i.text.includes('第三段')), '长帖拿到全文,不是截断的前半段');
      assert.ok(items.some((i) => i.text.includes('https://example.com/recipe')), 't.co 已展开成真实链接');
      assert.ok(items.every((i) => !/https:\/\/t\.co\//.test(i.text)), '正文里不残留 t.co 短链(媒体/引用的链接已去掉)');
      assert.ok(items.some((i) => i.replyTo && !i.text.startsWith('@')), '回复去掉了开头的 @提及');
      assert.ok(items.some((i) => i.handle === 'demo_writer') && items.some((i) => i.handle === 'sample_dev'), '新旧两种用户结构都读到了');

      const stats = await ctl('/__test/stats');
      assert.ok(stats.bmRequests >= 5, '应翻了多页,实际 ' + stats.bmRequests);

      await waitFor(async () => (await xTabs()).length === 0, 12000, 300, '同步用的标签页自动关闭');
    });

    await step('每日计划:条数在 4–24 内、与角标一致', async () => {
      let st = await rpc('state', { view: false });
      N = st.plan.ids.length;
      assert.equal(st.plan.day, today);
      assert.ok(st.plan.target >= 4 && st.plan.target <= 24, 'target=' + st.plan.target);
      assert.equal(N, st.plan.target, '书签池 87 条 ≥ 24,应抽满目标数');
      assert.equal(new Set(st.plan.ids).size, N, '不重复');
      assert.equal(st.items.length, N);
      assert.equal(await D('return await chrome.action.getBadgeText({});'), String(N));
      // 预览截图要有代表性:这批里没有带图片/视频的就重抽几次(这批还没人看过,重抽不留痕迹,只影响测试数据)
      for (let i = 0; i < 12 && !st.items.some((it) => it.media && it.media.length); i++) {
        await rpc('reroll');
        st = await rpc('state', { view: false });
      }
      N = st.plan.ids.length;
      assert.equal(await D('return await chrome.action.getBadgeText({});'), String(N));
    });

    /* ============================ 回顾页 ============================ */
    let app;
    await step('回顾页:渲染今日卡片、头像图片真的加载出来了', async () => {
      app = await openPage('chrome-extension://' + extId + '/app.html#today', { width: 920, height: 1000 });
      await appReady(app.sid, N);
      const info = await evalIn(
        app.sid,
        "({ prog: document.querySelector('#view-today .progress .num').textContent, sub: document.querySelector('.page-head .sub').textContent, loaded: [...document.querySelectorAll('.card .avatar img')].filter(i => i.naturalWidth > 0).length, links: [...document.querySelectorAll('.card .text a')].map(a => a.href) })"
      );
      assert.deepEqual(await cardIds(app.sid), (await getPlan()).ids, '卡片顺序 = 计划顺序');
      assert.equal(info.prog, '已回顾 0 / ' + N);
      assert.ok(info.sub.includes('今天抽到 ' + N + ' 条'), info.sub);
      assert.ok(info.loaded > 0, '头像应加载出来(模拟的 pbs.twimg.com)');
      assert.equal(await shownSum(), N, '今天出现的每条恰好计一次');
      await shot(app.sid, '02-今日回顾-浅色.png', { full: true });
      await showcase(app.sid, '02-浅色');
    });

    await step('回顾页:「回顾过了」写入并同步角标;「不再回顾」可撤销、原位放回', async () => {
      const before = await cardIds(app.sid);
      await evalIn(app.sid, "document.querySelector('#view-today .card .act.ok').click()");
      await waitFor(async () => (await getPlan()).done[before[0]], 5000, 200, '已回顾写入');
      assert.equal(await evalIn(app.sid, "document.querySelector('#view-today .progress .num').textContent"), '已回顾 1 / ' + before.length);
      assert.equal(await D('return await chrome.action.getBadgeText({});'), String(before.length - 1));

      const mutedId = await evalIn(
        app.sid,
        "(() => { const c = document.querySelectorAll('#view-today .card')[1]; [...c.querySelectorAll('.act')].find(x => x.textContent.includes('不再回顾')).click(); return c.dataset.id; })()"
      );
      assert.equal(mutedId, before[1]);
      await waitFor(async () => (await cardIds(app.sid)).length === before.length - 1, 6000, 200, '卡片被移走');
      const it = await D('return await DB.get("items", ' + JSON.stringify(mutedId) + ');');
      assert.equal(it.muted, true);
      const p2 = await getPlan();
      assert.equal(p2.ids.length, before.length - 1);
      assert.equal(p2.target, before.length - 1, '目标数同步减少,不冒替补');

      await evalIn(app.sid, "document.querySelector('#toast .toast-act').click()");
      await waitFor(async () => (await cardIds(app.sid)).length === before.length, 8000, 200, '撤销后卡片回来');
      assert.deepEqual(await cardIds(app.sid), before, '撤销后顺序与原来一致');
      const p3 = await getPlan();
      assert.equal(p3.target, before.length);
      assert.ok(p3.done[before[0]], '第一张的「已回顾」还在');
      assert.equal((await D('return await DB.get("items", ' + JSON.stringify(mutedId) + ');')).muted, false);
    });

    await step('回顾页:「再来 4 条」追加、「重新抽取」换一批并避开旧的', async () => {
      const n0 = (await cardIds(app.sid)).length;
      await evalIn(app.sid, "document.querySelector('#view-today .more .btn').click()");
      await waitFor(async () => (await cardIds(app.sid)).length === n0 + 4, 8000, 200, '再来 4 条');
      const ids1 = await cardIds(app.sid);
      assert.equal(await shownSum(), ids1.length, '追加的 4 条也恰好计一次');

      await evalIn(app.sid, "window.confirm = () => true; document.querySelector('#view-today .more .btn-ghost').click()");
      const p = await waitFor(async () => {
        const x = await getPlan();
        return x.ids.join() !== ids1.join() ? x : null;
      }, 8000, 200, '重新抽取');
      assert.equal(p.ids.filter((id) => ids1.includes(id)).length, 0, '新一批避开了刚才那批');
      assert.deepEqual(p.done, {}, '已回顾标记清空');
      await waitFor(async () => (await cardIds(app.sid)).join() === p.ids.join(), 8000, 200, '页面刷新成新一批');
      assert.equal(await shownSum(), p.ids.length, '旧批次的计数已撤销、新批次已计入');
      N = p.ids.length;
    });

    await step('截图:深色模式、手机宽度、全部书签、设置', async () => {
      const dark = await openPage('chrome-extension://' + extId + '/app.html#today', { width: 920, height: 1000, dark: true });
      await appReady(dark.sid, N);
      await shot(dark.sid, '03-今日回顾-深色.png', { full: true });
      await showcase(dark.sid, '03-深色');
      await cdp.send('Target.closeTarget', { targetId: dark.targetId });

      const mob = await openPage('chrome-extension://' + extId + '/app.html#today', { width: 390, height: 844, dsf: 2 });
      await appReady(mob.sid, N);
      await shot(mob.sid, '04-手机宽度.png', { full: true, maxH: 2600 });
      // 不能只看 scrollWidth(页面若设了 overflow-x:hidden 就看不出来),要逐个元素量右边缘
      const over = await evalIn(
        mob.sid,
        "(() => { const W = window.innerWidth; const bad = []; document.querySelectorAll('body *').forEach((e) => { if (getComputedStyle(e).position === 'fixed') return; const r = e.getBoundingClientRect(); if (r.width > 0 && r.right > W + 1) bad.push(e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0] + ' 右边=' + Math.round(r.right)); }); return { W, scroll: document.documentElement.scrollWidth, bad: bad.slice(0, 8) }; })()"
      );
      assert.equal(over.W, 390);
      assert.deepEqual(over.bad, [], '手机宽度下有元素伸出屏幕右边:' + JSON.stringify(over));
      assert.ok(over.scroll <= over.W, '手机宽度下不应出现横向滚动:' + JSON.stringify(over));
      await cdp.send('Target.closeTarget', { targetId: mob.targetId });

      const lib = await openPage('chrome-extension://' + extId + '/app.html#library', { width: 920, height: 1000 });
      await waitFor(() => evalIn(lib.sid, "document.querySelectorAll('#view-library .card').length >= 10"), 10000, 250, '全部书签列表');
      await imagesReady(lib.sid, '#view-library');
      await shot(lib.sid, '05-全部书签.png', { full: true, maxH: 3200 });
      // 搜索
      await evalIn(lib.sid, "(() => { const s = document.querySelector('#view-library .search'); s.value = '番茄'; s.dispatchEvent(new Event('input')); })()");
      await waitFor(() => evalIn(lib.sid, "document.querySelector('#view-library .count-line').textContent.startsWith('找到')"), 6000, 200, '搜索结果');
      const hits = await evalIn(lib.sid, "[...document.querySelectorAll('#view-library .card .text')].every(t => t.textContent.includes('番茄')) && document.querySelectorAll('#view-library .card').length");
      assert.ok(hits > 0, '搜「番茄」应有结果,且每条都含这个词');
      await cdp.send('Target.closeTarget', { targetId: lib.targetId });

      const set = await openPage('chrome-extension://' + extId + '/app.html#settings', { width: 920, height: 1000 });
      await waitFor(() => evalIn(set.sid, "document.querySelectorAll('#view-settings .panel').length >= 3"), 10000, 250, '设置页');
      await shot(set.sid, '06-设置.png', { full: true });
      await cdp.send('Target.closeTarget', { targetId: set.targetId });
    });

    await step('视频卡片:有封面、不点不下载、点开能真的播放(模拟 X 提供一段 mp4)', async () => {
      await ctl('/__test/stats?reset=1'); // 从现在起重新数「视频被下载了几次」
      const lib = await openPage('chrome-extension://' + extId + '/app.html#library', { width: 920, height: 1000 });
      await waitFor(() => evalIn(lib.sid, "document.querySelectorAll('#view-library .card').length >= 10"), 10000, 250, '全部书签列表');
      // 带视频的那条正文里有「番茄」
      await evalIn(lib.sid, "(() => { const s = document.querySelector('#view-library .search'); s.value = '番茄'; s.dispatchEvent(new Event('input')); })()");
      await waitFor(() => evalIn(lib.sid, "!!document.querySelector('#view-library video')"), 8000, 250, '搜索结果里出现带视频的书签');
      const info = await evalIn(
        lib.sid,
        "(() => { const v = document.querySelector('#view-library video'); return { poster: v.getAttribute('poster') || '', src: v.getAttribute('src') || '', preload: v.preload, can: v.canPlayType('video/mp4; codecs=\"avc1.42E01E\"'), net: v.networkState }; })()"
      );
      assert.match(info.poster, /^https:\/\/pbs\.twimg\.com\//, '封面来自 X 的图片服务器');
      assert.match(info.src, /^https:\/\/video\.twimg\.com\/.*\.mp4$/, '视频取的是 mp4 地址(不是 m3u8 播放列表)');
      assert.equal(info.preload, 'none', '不点播放就不下载视频');
      assert.notEqual(info.net, 2, '没点播放之前不应已经在加载视频');
      await sleep(1200);
      assert.equal((await ctl('/__test/stats')).videoRequests, 0, '没点播放时,页面不应去下载视频(省流量)');
      if (!videoFile) {
        console.log('      (本机没有 ffmpeg,没法造测试视频,跳过「真播放」这一项)');
      } else if (!info.can) {
        console.log('      (这个测试用浏览器不支持 H.264,跳过「真播放」这一项)');
      } else {
        const r = await evalIn(
          lib.sid,
          // 先滚到视野里:脚本触发的静音播放,Chrome 会在视频滑出视野时自动暂停(真人点播放不受这个限制)
          "(async () => { const v = document.querySelector('#view-library video'); v.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 500)); v.muted = true; try { await v.play(); } catch (e) { return { err: String(e) }; } await new Promise((r) => setTimeout(r, 1800)); return { t: v.currentTime, rs: v.readyState, paused: v.paused, code: v.error && v.error.code, w: v.videoWidth, d: v.duration }; })()"
        );
        assert.ok(!r.err && !r.code, '视频播放出错:' + JSON.stringify(r));
        assert.ok(r.t > 0.5 && r.w === 480, '应当真的在播放:' + JSON.stringify(r));
        assert.ok((await ctl('/__test/stats')).videoRequests > 0, '点了播放才去下载视频');
        await shot(lib.sid, '07-视频卡片播放中.png');
      }
      await cdp.send('Target.closeTarget', { targetId: lib.targetId });
    });

    /* ============================ 增量 / 完整同步 ============================ */
    await step('增量同步:只读到「已知」就停,新增 3 条,不翻整库(回顾页顶部有进度横幅)', async () => {
      const added = await ctl('/__test/add?n=3');
      await ctl('/__test/stats?reset=1');
      const before = await lastRunAt();
      const r = await rpc('syncStart', { mode: 'incremental' });
      assert.equal(r.started, true);
      // 回顾页顶部先出现「正在……」横幅,同步完变成「✓ 同步完成……」
      const bannerText = () => evalIn(app.sid, "(() => { const b = document.querySelector('#banner'); return b && !b.hidden ? b.textContent : ''; })()");
      await waitFor(async () => (await bannerText()).startsWith('正在'), 10000, 100, '回顾页出现进度横幅');
      await evalIn(app.sid, 'window.scrollTo(0, 0)');
      await shot(app.sid, '13-回顾页-同步中横幅.png').catch(() => {});
      const sync = await syncAfter(before);
      assert.equal(sync.lastOutcome, 'caughtUp');
      assert.equal(sync.lastAdded, 3);
      const done = await waitFor(async () => {
        const t = await bannerText();
        return t.startsWith('✓ 同步完成') ? t : null;
      }, 8000, 150, '回顾页出现完成横幅');
      assert.match(done, /^✓ 同步完成:读取 \d+ 条,新增 3 条/);
      await evalIn(app.sid, 'window.scrollTo(0, 0)');
      await shot(app.sid, '14-回顾页-同步完成横幅.png').catch(() => {});
      assert.equal((await allItems()).length, 90);
      const have = (await allItems()).map((i) => i.id);
      for (const id of added.ids) assert.ok(have.includes(id), '新收藏的 ' + id + ' 应已入库');
      const stats = await ctl('/__test/stats');
      assert.ok(stats.bmRequests <= 4, '增量同步应只翻 2–3 页,实际 ' + stats.bmRequests);
      await waitFor(async () => (await xTabs()).length === 0, 12000, 300, '同步标签页自动关闭');
    });

    await step('在书签页:浏览时顺手收进来;点右下角「同步」按钮原地重载并补齐,不替你关标签页', async () => {
      const add = await ctl('/__test/add?n=25'); // 比一页(20 条)多 5 条
      const before = await lastRunAt();
      const total0 = (await allItems()).length;
      const pg = await openPage('https://x.com/i/bookmarks', { width: 1100, height: 760, dsf: 1 });
      // 你自己点开书签页:页面加载的第一页书签会被顺手收进来(最新的 20 条)
      await waitFor(async () => (await allItems()).length === total0 + 20, 15000, 250, '浏览书签页时顺手入库第一页');
      // 右下角的小按钮在 closed shadow DOM 里,页面脚本摸不到;它的宿主元素在外面,量宿主的位置再真点
      const rect = await waitFor(
        () => evalIn(pg.sid, '(() => { const h = document.querySelector("[data-xbr]"); if (!h) return null; const b = h.getBoundingClientRect(); return b.width > 60 && b.height > 20 ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; })()'),
        15000,
        250,
        '页面右下角出现「同步」按钮'
      );
      await shot(pg.sid, '15-书签页-右下角同步按钮.png');
      for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) {
        await cdp.send('Input.dispatchMouseEvent', Object.assign({ type, x: rect.x, y: rect.y }, extra), pg.sid);
      }
      const sync = await syncAfter(before);
      assert.equal(sync.lastMode, 'incremental');
      assert.equal(sync.lastOutcome, 'caughtUp');
      assert.equal(sync.lastAdded, 5, '补齐第一页之外新增的 5 条');
      assert.equal((await allItems()).length, total0 + 25);
      const have = (await allItems()).map((i) => i.id);
      for (const id of add.ids) assert.ok(have.includes(id), '新收藏的 ' + id + ' 应已入库');
      await sleep(4500); // 自己开的同步标签页 3 秒多后会自动关;这个是「你的」标签页,必须还在
      const tabs = await xTabs();
      assert.equal(tabs.length, 1, '用户自己打开的书签页不应被关掉');
      assert.ok(tabs[0].url.startsWith('https://x.com/i/bookmarks'));
      await cdp.send('Target.closeTarget', { targetId: pg.targetId });
    });

    await step('完整同步:在 X 上取消收藏的 2 条被移出回顾池(软移除)', async () => {
      const rm = await ctl('/__test/remove?n=2');
      assert.equal(rm.ids.length, 2);
      const sync = await runSync('full');
      assert.equal(sync.lastOutcome, 'end');
      assert.equal(sync.lastRemoved, 2);
      const items = await allItems();
      for (const id of rm.ids) assert.equal(items.find((i) => i.id === id).removed, true);
      assert.equal(items.filter((i) => i.removed).length, 2, '只有这 2 条被移出');
      const st = await rpc('state', { view: false });
      assert.equal(st.counts.removed, 2);
      assert.ok(!st.plan.ids.some((id) => rm.ids.includes(id)), '今日计划里不含已移出的');
      await waitFor(async () => (await xTabs()).length === 0, 12000, 300, '同步标签页自动关闭');
    });

    /* ============================ 实时收藏 ============================ */
    await step('实时收藏:在 X 上点书签就收进来;取消收藏就移出;再收藏就恢复', async () => {
      const h = await openPage('https://x.com/home', { width: 1100, height: 760, dsf: 1 });
      await waitFor(() => evalIn(h.sid, 'document.querySelectorAll("article").length === 3'), 15000, 250, '首页时间线渲染');
      await sleep(600);
      const id = mock.state.home[1].id;
      const sel = 'article[data-id="' + id + '"] ';
      await evalIn(h.sid, 'document.querySelector(' + JSON.stringify(sel + '.bm') + ').click()');
      const it = await waitFor(() => D('const i = await DB.get("items", ' + JSON.stringify(id) + '); return i && i.source === "live" ? i : null;'), 8000, 200, '实时收藏入库');
      assert.ok(it.text.includes('首页时间线上的一条'), '内容来自页面缓存');
      assert.ok(Math.abs(it.bookmarkedAt - Date.now()) < 60000, '收藏时间就是现在');
      assert.ok((await ctl('/__test/stats')).created.includes(id));
      await sleep(400);
      await shot(h.sid, '12-实时收藏-页面提示.png').catch(() => {});

      await evalIn(h.sid, 'document.querySelector(' + JSON.stringify(sel + '.unbm') + ').click()');
      await waitFor(() => D('const i = await DB.get("items", ' + JSON.stringify(id) + '); return i && i.removed === true;'), 8000, 200, '取消收藏 → 移出');
      await evalIn(h.sid, 'document.querySelector(' + JSON.stringify(sel + '.bm') + ').click()');
      await waitFor(() => D('const i = await DB.get("items", ' + JSON.stringify(id) + '); return i && i.removed === false;'), 8000, 200, '再次收藏 → 恢复');
      await cdp.send('Target.closeTarget', { targetId: h.targetId });
    });

    /* ============================ 换日 ============================ */
    await step('换日:新的一天抽新的一批,优先抽没出现过的;没被看到就不计次数', async () => {
      const old = await getPlan();
      const items0 = await allItems();
      const zero = items0.filter((i) => !i.muted && !i.removed && !(i.shownCount | 0)).map((i) => i.id);
      const sum0 = await shownSum();
      await D('const p = await DB.kvGet("plan"); p.day = "2000-01-01"; await DB.kvSet("plan", p);');
      const st = await rpc('state', { view: false });
      assert.equal(st.plan.day, today);
      assert.equal(st.plan.seen, false);
      assert.notEqual(st.plan.ids.join(), old.ids.join());
      if (st.plan.target <= zero.length) assert.ok(st.plan.ids.every((id) => zero.includes(id)), '应优先抽没出现过的');
      assert.equal(await shownSum(), sum0, '没被看到时不计次数');
      await rpc('state', { view: true });
      assert.equal(await shownSum(), sum0 + st.plan.ids.length, '被看到后才计次数');
    });

    /* ============================ 设置与闹钟 ============================ */
    await step('设置:条数范围校验、重抽生效、提醒闹钟随时间设置变化', async () => {
      const s = await rpc('settings', { patch: { countMin: 6, countMax: 6 } });
      assert.deepEqual([s.countMin, s.countMax], [6, 6]);
      const swapped = await rpc('settings', { patch: { countMin: 30, countMax: 10 } });
      assert.deepEqual([swapped.countMin, swapped.countMax], [30, 30], '最多不能小于最少');
      await rpc('settings', { patch: { countMin: 6, countMax: 6 } });
      await rpc('reroll');
      const st = await rpc('state', { view: false });
      assert.equal(st.plan.ids.length, 6, '固定 6 条');
      assert.deepEqual(st.range, { min: 6, max: 6 });

      const alarms = () => D('return await chrome.alarms.getAll();');
      let a = await alarms();
      const rem = a.find((x) => x.name === 'xbr-reminder');
      const mid = a.find((x) => x.name === 'xbr-midnight');
      assert.ok(rem && mid, '提醒和午夜换日两个闹钟都应存在');
      const rd = new Date(rem.scheduledTime);
      assert.deepEqual([rd.getHours(), rd.getMinutes()], [9, 0]);
      assert.ok(rem.scheduledTime > Date.now() && rem.scheduledTime - Date.now() <= 24 * 3600e3 + 1000);
      const md = new Date(mid.scheduledTime);
      assert.deepEqual([md.getHours(), md.getMinutes(), md.getSeconds()], [0, 0, 30]);

      await rpc('settings', { patch: { reminderTime: '21:30' } });
      a = await alarms();
      const rd2 = new Date(a.find((x) => x.name === 'xbr-reminder').scheduledTime);
      assert.deepEqual([rd2.getHours(), rd2.getMinutes()], [21, 30]);
      await rpc('settings', { patch: { reminderEnabled: false } });
      assert.ok(!(await alarms()).some((x) => x.name === 'xbr-reminder'), '关掉提醒后闹钟应被清除');
      await rpc('settings', { patch: { reminderEnabled: true, reminderTime: '09:00' } });
      assert.ok((await alarms()).some((x) => x.name === 'xbr-reminder'));
    });

    await step('到点提醒:发出通知、记录当天已提醒、排好下一次闹钟', async () => {
      const st = await rpc('state', { view: false });
      assert.ok(st.plan.ids.length > 0);
      await D('await chrome.alarms.create("xbr-reminder", { when: Date.now() + 1500 });');
      await waitFor(() => D('return (await DB.kvGet("lastNotifyDay")) === self.XBR_PLAN.dayKey();'), 15000, 300, '提醒已发出(lastNotifyDay)');
      const ids = await D('return await new Promise((r) => chrome.notifications.getAll(r));');
      console.log('      系统通知列表(无头模式下可能为空,仅供参考):' + JSON.stringify(Object.keys(ids || {})));
      await waitFor(async () => {
        const a = (await D('return await chrome.alarms.getAll();')).find((x) => x.name === 'xbr-reminder');
        return a && a.scheduledTime > Date.now() + 30000;
      }, 8000, 300, '下一次提醒闹钟已排好');
    });

    /* ============================ 备份 ============================ */
    await step('备份:导出 → 清空 → 导入,数据(含回顾次数/移出状态)原样回来', async () => {
      const before = await allItems();
      const exp = await rpc('export');
      assert.equal(exp.app, 'x-bookmark-review');
      assert.equal(exp.items.length, before.length);
      await rpc('clearAll');
      assert.equal((await rpc('state', { view: false })).counts.total, 0);
      assert.equal(await D('return await chrome.action.getBadgeText({});'), '', '清空后角标应为空');
      const r = await rpc('import', { data: exp });
      assert.equal(r.added, before.length);
      const key = (arr) => arr.map((i) => [i.id, i.shownCount | 0, !!i.muted, !!i.removed, i.text].join('|')).sort().join('\n');
      assert.equal(key(await allItems()), key(before));
      const bad = await rpcRaw('import', { data: { foo: 1 } });
      assert.equal(bad.ok, false);
      assert.match(bad.error, /不是本扩展/);
      const again = await rpc('import', { data: exp });
      assert.equal(again.added, 0);
      assert.equal(again.existed, before.length);
    });

    /* ============================ X 改版兜底 / 出错 ============================ */
    await step('X 改版(数据格式读不懂)→ 自动退回读页面文字,且不据此清理书签', async () => {
      await rpc('clearAll');
      await ctl('/__test/mode?m=broken');
      const fullBefore = await D('const s = await DB.kvGet("sync"); return (s && s.lastFullAt) || 0;');
      const sync = await runSync('full');
      const real = (await ctl('/__test/stats')).real;
      assert.equal(sync.lastOutcome, 'end');
      const items = await allItems();
      assert.equal(items.length, real, '页面上有多少条就读到多少条');
      assert.ok(items.every((i) => i.source === 'dom'), '全部来自读页面文字');
      assert.ok(items.every((i) => i.text && i.handle && i.name), '文字、作者都读到了');
      const fullAfter = await D('const s = await DB.kvGet("sync"); return (s && s.lastFullAt) || 0;');
      assert.equal(fullAfter, fullBefore, '读页面文字不算「完整同步」');
      assert.equal(sync.lastRemoved, 0);
      await ctl('/__test/mode?m=normal');
      await waitFor(async () => (await xTabs()).length === 0, 12000, 300, '同步标签页自动关闭');
    });

    await step('出错(X 返回 403):报告原因、标签页留着给你看,不清理任何书签', async () => {
      await ctl('/__test/mode?m=fail403');
      const sync = await runSync('full');
      assert.equal(sync.lastOutcome, 'http');
      const tabs = await xTabs();
      assert.ok(tabs.length >= 1, '出错时不应自动关掉标签页');
      for (const t of tabs) await cdp.send('Target.closeTarget', { targetId: t.targetId });
      await ctl('/__test/mode?m=normal');
    });

    await step('没登录 X:被带去登录页 → 回顾页提示先登录,任务正常收尾,书签原样不动', async () => {
      await ctl('/__test/mode?m=loggedout');
      const total0 = (await allItems()).length;
      const r = await rpc('syncStart', { mode: 'full' });
      assert.equal(r.started, true);
      const bannerText = () => evalIn(app.sid, "(() => { const b = document.querySelector('#banner'); return b && !b.hidden ? b.textContent : ''; })()");
      await waitFor(async () => ((await bannerText()).includes('请先在这个浏览器里登录 X') ? true : null), 15000, 200, '回顾页提示先登录');
      await evalIn(app.sid, 'window.scrollTo(0, 0)');
      await shot(app.sid, '16-没登录-回顾页提示.png').catch(() => {});
      assert.equal(await D('const j = await chrome.storage.session.get("jobs"); return Object.keys(j.jobs || {}).length;'), 0, '同步任务已收尾,不会卡在「同步中」');
      assert.equal(await evalIn(app.sid, "document.querySelector('#syncBtn').disabled"), false, '同步按钮恢复可点');
      assert.equal((await allItems()).length, total0, '书签原样没动');
      const tabs = await xTabs();
      assert.ok(tabs.some((x) => x.url.includes('/i/flow/login')), '标签页停在登录页,方便你直接登录');
      for (const x of tabs) await cdp.send('Target.closeTarget', { targetId: x.targetId });
      await ctl('/__test/mode?m=normal');
    });

    await step('全程没有未捕获的异常或 console.error(后台与扩展页面)', async () => {
      assert.deepEqual(problems, [], JSON.stringify(problems, null, 1));
    });

    console.log('\n全部 ' + passed + ' 个场景通过。截图在:' + SHOTS);
    ws.close();
  } finally {
    try {
      chrome.kill('SIGKILL');
    } catch (_) {}
    mock.close();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('\n实测失败:' + e.message + '\n工作目录(含截图):' + WORK);
    process.exit(1);
  }
);
