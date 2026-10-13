/**
 * @kirara/dsh-plugin-kirara-theme — 宿主半边（host half）
 *
 * 作用：把 Kirara Server 的首页背景图片管线复刻到 DeepSeek Harness 上。
 *
 * 复刻自 `Kirara_Server/Services/BackgroundService.cs`：
 *   远端资源（GET <apiBaseUrl><endpoint>，302 → MinIO 预签名 URL）
 *     → 版本识别（ETag 优先，X-Resource-Version 兜底）
 *       → 版本未变则零下载
 *       → 版本变化则下载字节写入本地缓存（写盘后原子替换）
 *         → 通过本地 HTTP 路由回吐给 Web GUI（`<routePath>/background.jpg?v=<版本>`）
 *           → 客户端交叉淡入应用；取不到图时回退默认渐变
 *
 * 为什么由宿主代理而不是浏览器直连：
 *   GUI 是 http://127.0.0.1:<port> 明文同源页面，API 是 https://…:1010，
 *   浏览器直连会撞 CORS / 混合内容 / 证书；宿主进程直连没有任何这些限制，
 *   同时把 4.4MB 的背景图变成同源、可强缓存（immutable）的本地资源。
 *
 * 契约（与 `dsh-client-ui-theme` 的宿主半边同构）：
 *   - `export { Config, apply }`，插件名来自 bundle 行，文件内不写 name/inject。
 *   - 通过 `ctx.inject(['webServer'], …)` 拿到 HTTP 载体服务。
 *   - 通过 `ctx.on('webserver/index-inject', …)` 注入首屏样式与全局配置，
 *     `index-inject` 每次渲染索引页都会重新 emit，因此订阅者读到的是实时状态。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

/** 默认 API 基地址：与 Kirara_Server 客户端 `DefaultApiBaseUrl` 一致。 */
const DEFAULT_API_BASE_URL = 'https://api.akeno6388.online:1010';
/** 默认背景资源端点。 */
const DEFAULT_ENDPOINT = '/api/resources/home-background';
/** 默认本地路由前缀（客户端据此拼 `<routePath>/background.jpg`）。 */
const DEFAULT_ROUTE_PATH = '/kirara-theme';
/** 默认同步冷却：30 分钟，镜像 `BackgroundService.SyncCooldown`。 */
const DEFAULT_SYNC_INTERVAL_MINUTES = 30;
/** 默认单次请求超时。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

/** 缓存文件名。 */
const CACHE_FILE = 'background.bin';
const STATE_FILE = 'state.json';
/** 注入到索引页的全局变量名。 */
const GLOBAL_KEY = '__KIRARA_THEME__';
/**
 * 首屏样式表最前面的标记注释（写在注入的 `<style>` 文本里）。
 *
 * ⚠️ 必须与 `lib/client.js` 的 `BOOT_MARKER` **逐字节一致**。
 *
 * 为什么需要它：`webserver/index-inject` 只在**渲染索引页**时 emit 一次，那一行
 * `<style>` 一经写进 HTML 就永久留在文档里。运行时把插件关掉时，宿主半边的 effect
 * 清理只能做到「以后不再注入」，碰不到已经送到浏览器里的那一份 —— 于是外观会一直
 * 留着，直到整页刷新（症状：关掉插件后主题还在）。客户端半边凭这个标记把首屏样式
 * 一并摘掉，见 `lib/client.js` 的 `removeBootStyles()`。
 *
 * 标记只放在**拼接处**（不放进 `bootCss()` 的规则数组），这样
 * `scripts/check-css-parity.mjs` 的「逐行同源」断言仍然只比对纯 CSS。
 */
const BOOT_MARKER = '/*! kirara-theme-boot */';
/**
 * 背景照片自定义属性名（写在 `<html>` 上行内样式里）。
 *
 * ⚠️ 必须与 `lib/client.js` 的 `PHOTO_VAR` **逐字节一致**：宿主半边首屏用它写首帧 URL，
 * 客户端半边接手后用内联样式换图 / 回落，两边写的是同一个属性。
 */
const PHOTO_VAR = '--kirara-theme-photo';

/**
 * 默认背景：纯 CSS 渐变，不随包分发任何图片资源。
 *
 * ⚠️ 本常量必须与 `lib/client.js` 的 `FALLBACK_PHOTO` **逐字节一致**
 * （README §4.2 的防漂移契约）：它同时出现在两处——
 *   1) 首屏注入样式里 `:root::before` 的 `background-image` 回落值；
 *   2) 客户端半边解码失败 / 服务器无图时的 `showFallback()` 写回值。
 * 两处不一致会在「服务器图 404 → 回落」的瞬间出现一层渐变闪变。
 */
const DEFAULT_BACKDROP_CSS = 'linear-gradient(135deg,#1b2030 0%,#0d1017 60%,#080a10 100%)';

/**
 * 侧栏列的不透明度（★ 语义是「**透明度**」，0 = 完全不透明，1 = 完全透明）。
 *
 * 用「透明度」而不是「不透明度」命名，是为了避免下面这种经典反转错误：
 * 想更透 → 却把 `rgba(...,.72)` 的手写值改成 `.85`（那反而更实心）。
 * 实际写进 CSS 的是 `1 - 本值`。
 *
 * 取值依据：0.42 ⇒ rg 通道实心度 0.58。配合 `html::after` 的 .55 黑遮罩一起看，
 * 侧栏在深色下 ≈ 21、浅色下 ≈ 150，正文对比度仍然够用；再低（>0.6）就开始明显糊字。
 *
 * ⚠️ 这个字面量必须与 `lib/client.js` 里 `OVERRIDE_CSS` 的同名常量**逐字节一致**
 * （首屏注入的 CSS 与客户端 CSS 的「同源契约」，由 `scripts/check-css-parity.mjs` 断言）。
 */
const SIDEBAR_ALPHA = 0.42;
/** 侧栏列底色（浅色 / 深色）。alpha 由 `SIDEBAR_ALPHA` 决定。 */
const SIDEBAR_FILL_LIGHT = 'rgba(249,250,252,';
const SIDEBAR_FILL_DARK = 'rgba(20,22,28,';

/**
 * 把 `SIDEBAR_ALPHA` 换算成写进 CSS 的**实心度**（= 1 - 透明度），并去掉浮点毛刺。
 *
 * ⚠️ 必须取整：`1 - 0.42` 在 IEEE 754 下是 `0.5800000000000001`，
 * 直接拼进 CSS 会写出 `rgba(...,0.5800000000000001)` —— 能生效，但既难看又脆弱
 *（任何一边算式的微小改动都会让首屏与客户端的字符串不再逐字节相同）。
 * 取三位小数对 0~255 的通道来说远超肉眼精度。
 */
function sidebarFillAlpha() {
  return Math.round((1 - SIDEBAR_ALPHA) * 1000) / 1000;
}

const Config = z.object({
  enabled: z.boolean().default(true),
  apiBaseUrl: z.string().default(DEFAULT_API_BASE_URL),
  endpoint: z.string().default(DEFAULT_ENDPOINT),
  routePath: z.string().default(DEFAULT_ROUTE_PATH),
  syncIntervalMinutes: z.number().default(DEFAULT_SYNC_INTERVAL_MINUTES),
  requestTimeoutMs: z.number().default(DEFAULT_REQUEST_TIMEOUT_MS),
  cacheDir: z.string().default(''),
});

/** 单例状态：宿主进程内只有一个背景资源。 */
const state = {
  /** 已落盘字节；null 表示尚无任何远端背景（走默认渐变）。 */
  bytes: null,
  contentType: 'image/jpeg',
  etag: null,
  resourceVersion: null,
  version: null,
  updatedAt: null,
  source: 'default',
  lastError: null,
  lastAttemptAt: null,
  /** 进行中的同步任务（in-flight 合并，避免并发重复下载）。 */
  inFlight: null,
  /** 远端探测到的“最新”版本标识，用于跳过重复下载。 */
  probeVersion: null,
  cacheDir: null,
};

/** 解析缓存目录：显式配置 → DSH_HOME → 用户目录 → 临时目录。 */
function resolveCacheDir(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit) return explicit;

  const home = process.env.DSH_HOME || process.env.DSH_PROFILE_HOME || '';
  if (home && home.trim()) {
    return path.join(home.trim(), 'kirara-theme');
  }

  try {
    return path.join(os.homedir(), '.dsh', 'kirara-theme');
  } catch {
    return path.join(os.tmpdir(), 'dsh-kirara-theme');
  }
}

/** 规整路由前缀：保证以 `/` 开头、不以 `/` 结尾。 */
function normalizeRoutePath(value) {
  let route = typeof value === 'string' ? value.trim() : '';
  if (!route) route = DEFAULT_ROUTE_PATH;
  if (!route.startsWith('/')) route = '/' + route;
  while (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1);
  return route;
}

/** 拼接远端资源 URL。 */
function remoteUrl(config) {
  const base = (config.apiBaseUrl || '').trim().replace(/\/+$/, '');
  let endpoint = (config.endpoint || '').trim();
  if (!endpoint.startsWith('/')) endpoint = '/' + endpoint;
  return base + endpoint;
}

/** 带超时的 fetch。 */
async function timedFetch(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跟随一次重定向并返回最终响应。
 * 与 `BackgroundService` 一致：先手动接管 302，再跟随 Location 取真实资源，
 * 这样既能看到 302 上的廉价版本头（X-Resource-Version），
 * 又能拿到 MinIO 返回的权威 ETag。
 */
async function fetchFollowing(url, timeoutMs) {
  const first = await timedFetch(url, { method: 'GET', redirect: 'manual' }, timeoutMs);

  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location');
    const cheapVersion = first.headers.get('x-resource-version');
    const age = first.headers.get('age');
    // 释放 302 响应体，避免 socket 悬挂。
    try {
      await first.arrayBuffer();
    } catch {
      /* 忽略 */
    }
    if (!location) {
      return { status: first.status, headers: first.headers, response: null, cheapVersion };
    }
    const followed = await timedFetch(
      new URL(location, url).toString(),
      { method: 'GET', redirect: 'follow' },
      timeoutMs,
    );
    return { status: followed.status, headers: followed.headers, response: followed, cheapVersion };
  }

  return {
    status: first.status,
    headers: first.headers,
    response: first,
    cheapVersion: first.headers.get('x-resource-version'),
  };
}

/** 由响应头推导版本标识（ETag 优先，X-Resource-Version 兜底）。 */
function deriveVersion(headers, cheapVersion) {
  const etag = headers.get('etag') || null;
  if (etag) {
    return { version: etag, etag, resourceVersion: cheapVersion };
  }
  const rv = cheapVersion || headers.get('x-resource-version') || null;
  if (rv) {
    return { version: 'rv:' + rv, etag: null, resourceVersion: rv };
  }
  const lastModified = headers.get('last-modified');
  if (lastModified) {
    return { version: 'lm:' + lastModified, etag: null, resourceVersion: rv };
  }
  return { version: null, etag: null, resourceVersion: rv };
}

/** 原子写文件：先写临时文件再 rename，避免 GUI 读到半个文件。 */
async function writeFileAtomic(target, data) {
  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, target);
}

/** 持久化当前状态到 state.json（失败只记录，不抛出）。 */
async function persistState() {
  if (!state.cacheDir) return;
  const snapshot = {
    version: state.version,
    etag: state.etag,
    resourceVersion: state.resourceVersion,
    contentType: state.contentType,
    bytes: state.bytes ? state.bytes.length : 0,
    isDefault: state.bytes === null,
    updatedAt: state.updatedAt,
    source: state.source,
    lastError: state.lastError,
    lastAttemptAt: state.lastAttemptAt,
  };
  try {
    await writeFileAtomic(path.join(state.cacheDir, STATE_FILE), JSON.stringify(snapshot, null, 2));
  } catch {
    /* 缓存不可写不应影响运行 */
  }
}

/** 启动时从磁盘恢复缓存（离线也能立刻画上背景）。 */
async function restoreFromDisk() {
  if (!state.cacheDir) return;
  try {
    const buf = await fsp.readFile(path.join(state.cacheDir, CACHE_FILE));
    if (buf.length > 0) {
      state.bytes = buf;
      state.source = 'cache';
      state.updatedAt = new Date().toISOString();
    }
  } catch {
    /* 无缓存则保持默认 */
  }
  try {
    const raw = await fsp.readFile(path.join(state.cacheDir, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (!state.bytes && parsed.isDefault === false) {
        // 缓存文件缺失但曾成功下载过 → 记录版本，下次同步会重新下载。
        state.version = null;
      } else {
        state.version = typeof parsed.version === 'string' ? parsed.version : state.version;
      }
      state.etag = typeof parsed.etag === 'string' ? parsed.etag : state.etag;
      state.resourceVersion =
        parsed.resourceVersion != null ? String(parsed.resourceVersion) : state.resourceVersion;
      if (typeof parsed.contentType === 'string' && parsed.contentType) {
        state.contentType = parsed.contentType;
      }
      if (state.bytes) state.source = 'cache';
    }
  } catch {
    /* 忽略 */
  }
}

/**
 * 同步一次远端背景。
 * - 版本一致 → 零下载直接返回；
 * - 404 / 异常 → 保留当前背景（绝不因为一次网络抖动把背景抹掉）。
 */
async function syncOnce(config, { force = false } = {}) {
  if (!config.enabled) return { skipped: 'disabled' };
  const base = (config.apiBaseUrl || '').trim();
  if (!base) return { skipped: 'no-api-base' };

  state.lastAttemptAt = new Date().toISOString();
  const url = remoteUrl(config);
  const timeoutMs = Math.max(1000, Number(config.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);

  try {
    const result = await fetchFollowing(url, timeoutMs);

    if (result.status === 404) {
      state.lastError = 'remote returned 404';
      await persistState();
      return { skipped: 'not-found' };
    }
    if (!result.response || result.status < 200 || result.status >= 300) {
      state.lastError = 'remote returned ' + result.status;
      await persistState();
      return { skipped: 'http-' + result.status };
    }

    const derived = deriveVersion(result.headers, result.cheapVersion);
    state.probeVersion = derived.version;

    if (!force && derived.version && state.version && derived.version === state.version && state.bytes) {
      state.lastError = null;
      state.source = 'server';
      await persistState();
      return { skipped: 'unchanged', version: derived.version };
    }

    const buffer = Buffer.from(await result.response.arrayBuffer());
    if (buffer.length === 0) {
      state.lastError = 'remote returned empty body';
      await persistState();
      return { skipped: 'empty' };
    }

    const contentType = result.headers.get('content-type') || 'image/jpeg';

    state.bytes = buffer;
    state.contentType = contentType;
    state.etag = derived.etag;
    state.resourceVersion = derived.resourceVersion;
    state.version = derived.version || 'bytes:' + buffer.length;
    state.updatedAt = new Date().toISOString();
    state.source = 'server';
    state.lastError = null;

    if (state.cacheDir) {
      try {
        await fsp.mkdir(state.cacheDir, { recursive: true });
        await writeFileAtomic(path.join(state.cacheDir, CACHE_FILE), buffer);
      } catch (error) {
        state.lastError = 'cache write failed: ' + (error && error.message);
      }
    }
    await persistState();
    return { updated: true, version: state.version, bytes: buffer.length };
  } catch (error) {
    // 超时 / DNS / TLS / 证书……一律保留当前背景。
    state.lastError = (error && error.message) || String(error);
    await persistState();
    return { skipped: 'error', error: state.lastError };
  }
}

/** in-flight 合并：同一时刻只允许一次同步。 */
function ensureSynced(config, options) {
  if (state.inFlight) return state.inFlight;
  const task = syncOnce(config, options).finally(() => {
    state.inFlight = null;
  });
  state.inFlight = task;
  return task;
}

/** 当前对外的状态快照（给 state.json 与首屏注入用）。 */
function publicState(config) {
  return {
    version: state.version,
    shortVersion: state.version ? String(state.version).slice(0, 12) : null,
    contentType: state.contentType,
    size: state.bytes ? state.bytes.length : 0,
    isDefault: state.bytes === null,
    hasImage: state.bytes !== null,
    etag: state.etag,
    resourceVersion: state.resourceVersion,
    updatedAt: state.updatedAt,
    source: state.source,
    lastError: state.lastError,
    imageUrl:
      state.bytes !== null
        ? normalizeRoutePath(config.routePath) +
          '/background.jpg' +
          (state.version ? '?v=' + encodeURIComponent(String(state.version).slice(0, 24)) : '')
        : null,
    routePath: normalizeRoutePath(config.routePath),
    initialized: state.lastAttemptAt !== null,
  };
}

/** 解析 JSON 请求体（refresh / invalidate 用）。 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 本地路由处理器。
 * 契约：`WebServer.register` 的 handler 拥有完整响应所有权，
 * 且必须在任何 await 之前 try/catch —— 抛异常时若响应头尚未写出，
 * WebServer 会回一个 400。
 */
function createRouteHandler(config) {
  const routePath = normalizeRoutePath(config.routePath);

  return async (req, res) => {
    try {
      const raw = req.url || routePath;
      const queryIndex = raw.indexOf('?');
      const pathname = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
      const search = queryIndex >= 0 ? new URLSearchParams(raw.slice(queryIndex + 1)) : new URLSearchParams();
      const suffix = pathname.slice(routePath.length).replace(/^\/+/, '');
      const method = (req.method || 'GET').toUpperCase();

      // GET <routePath>/background | /background.jpg | /state.json | /background/default
      if (method === 'GET' || method === 'HEAD') {
        if (suffix === '' || suffix === 'state.json') {
          sendJson(res, 200, publicState(config));
          return;
        }

        if (suffix === 'background/default') {
          // 默认背景标记：客户端据此渲染 CSS 渐变。
          const body = Buffer.from(
            JSON.stringify({ isDefault: true, backdrop: DEFAULT_BACKDROP_CSS }),
            'utf8',
          );
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(body.length),
            'cache-control': 'no-store',
          });
          res.end(body);
          return;
        }

        if (suffix === 'background' || suffix === 'background.jpg') {
          if (state.bytes === null) {
            // 无远端背景 → 302 到默认标记，客户端据此走渐变分支。
            res.writeHead(302, { location: routePath + '/background/default', 'cache-control': 'no-store' });
            res.end();
            return;
          }
          const version = state.version ? String(state.version).slice(0, 24) : 'noversion';
          res.writeHead(200, {
            'content-type': state.contentType || 'image/jpeg',
            'content-length': String(state.bytes.length),
            etag: '"' + version.replace(/"/g, '') + '"',
            'cache-control': 'public, max-age=31536000, immutable',
            'x-kirara-theme-version': version,
          });
          if (method === 'HEAD') res.end();
          else res.end(state.bytes);
          return;
        }
      }

      // POST <routePath>/refresh  → 强制立即同步一次
      // POST <routePath>/invalidate → 丢弃当前背景，回到默认渐变
      if (method === 'POST') {
        if (suffix === 'refresh') {
          const body = await readJsonBody(req);
          const force = !body || body.force !== false;
          const result = await ensureSynced(config, { force });
          sendJson(res, 200, { ok: true, result, state: publicState(config) });
          return;
        }
        if (suffix === 'invalidate') {
          state.bytes = null;
          state.version = null;
          state.etag = null;
          state.resourceVersion = null;
          state.source = 'default';
          state.updatedAt = new Date().toISOString();
          if (state.cacheDir) {
            try {
              await fsp.rm(path.join(state.cacheDir, CACHE_FILE), { force: true });
            } catch {
              /* 忽略 */
            }
          }
          await persistState();
          sendJson(res, 200, { ok: true, state: publicState(config) });
          return;
        }
      }

      sendJson(res, 404, { ok: false, error: 'unknown kirara-theme endpoint: ' + suffix });
    } catch (error) {
      const message = (error && error.message) || String(error);
      state.lastError = message;
      try {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: message });
        else res.end();
      } catch {
        /* 响应已不可写 */
      }
    }
  };
}

/**
 * 首屏注入样式。
 *
 * 这一层是「无闪白」的关键：官方 `dsh-client-ui-theme` 就是用同样的
 * `webserver/index-inject` + `kind:"style"` 通道把明暗主题底色的首屏 CSS
 * 写进索引页的。这里负责客户端脚本执行**之前**的首屏观感：
 *   1) 铺好背景层与遮罩层，避免白闪；
 *   2) 本地已有服务器背景缓存时，首屏直接用自定义属性指向同源路由取图（强缓存零延迟）；
 *   3) 把侧栏列（含 Windows 标题栏壳下的右上角圆角）/内容列/右侧栏的半透明规则一并给出，
 *      并让 Windows 顶栏（外框 + 拖拽条）保持透明、直接露出背景图层（不铺遮罩），
 *      使客户端接手时不产生样式跳变；
 *   4) 同时把宿主在内层根元素（侧栏各面板根、会话主界面根、输入区底座）上的
 *      **不透明实色底清成 transparent** ——
 *      首屏若漏清，脚本接手前会先闪一帧「纯色界面」（磨砂只由列承担，见 client.js 约束 8）。
 *
 * ⚠️ 背景/遮罩**不是 DOM 节点**，而是 `html` 自身的 `::before` / `::after` 伪元素，
 * 一律 `position:fixed; inset:0; z-index:-1`。原因（实测事故）：应用内容
 * 应用外框（`.<哈希前缀>_frame`）是 `position:relative; z-index:auto`，把 `position:fixed` 的浮层
 * 追加到 `#root` 之后必然绘制在整个应用之上，会盖住对话文字与左侧栏。
 * 只有挂在 `html` 根上的**负 z-index 伪元素**才绘制在根背景之后、所有常规流内容之前。
 * 照片本身走 `html` 上的自定义属性 `--kirara-theme-photo`（由 `::before` 消费），
 * 客户端半边只写内联样式即可换图 —— 全程不插入任何元素节点。
 *
 * ⚠️ 本层用**不带属性**的裸 `:root` 前缀（首屏 `data-kirara-theme` 尚未写入），
 * 除 `background-image` 一行外与 `lib/client.js` 的 `OVERRIDE_CSS` **逐条同源**；
 * 改动任一侧都必须同步另一侧，否则首屏会出现样式漂移闪帧。
 * ⚠️ 绝不在 `body` / `html` 上写 `color`：任何 `!important` 颜色都会被整棵子树继承，
 * 直接把 harness 的文字与图标染成同色（「只剩背景图、内部 UI 全看不见」事故的根因）。
 */
function bootCss(config) {
  const routePath = normalizeRoutePath(config.routePath);
  const hasImage = state.bytes !== null;
  const version = state.version ? String(state.version).slice(0, 24) : null;

  // 首屏前缀：此刻客户端半边还没跑，`data-kirara-theme` 尚未写入 → 一律用裸 `:root`。
  // 客户端接手后会写入该属性（并在卸载时摘掉），届时它的 (0,3,0) 前缀压过这里的 (0,2,0)。
  const P = ':root';
  const PD = ':root body[data-ds-dark-theme]';
  const PT = ':root[data-windows-titlebar]';
  const PTD = PT + ' body[data-ds-dark-theme]';

  // 有图时：首屏就写自定义属性，让 `::before` 直接指向本地同源路由取真实服务器背景
  // （离线时浏览器命中磁盘缓存，仍然是零延迟）。
  // ⚠️ 不能带 `!important`：客户端半边随后用**内联样式**换图 / 回落，内联优先级更高。
  const photo = hasImage
    ? ':root{' +
      PHOTO_VAR +
      ':url("' +
      routePath +
      '/background.jpg' +
      (version ? '?v=' + encodeURIComponent(version) : '') +
      '")}'
    : null;

  // ⚠️ 以下规则必须与 `lib/client.js` 的 `OVERRIDE_CSS` 逐条对齐：
  // 这里负责首屏（客户端脚本尚未执行）的底色与背景层，客户端随后用同规则接管，任何漂移都会造成首屏闪帧。
  return [
    // 侧栏列：半透明底
    // 磨砂只由列承担（约束 8）—— 侧栏内部面板根的实色底必须清掉，
    // 否则两层同色半透明叠加会把侧栏推回 ≈0.92 实心。
    //
    // ★ 选择器约定（v0.2.0 起）：只按 CSS Modules 的本地名后缀匹配，不写哈希前缀。
    //   .module.css 编译出的类名形如 <哈希前缀>_<本地名>：本地名来自源码、跨构建稳定，
    //   哈希前缀每次构建都可能变（官方 0.2.0-rc.2 = .BynINW_sidebarCol，
    //   EduWork 内置的新版 DSH = .pI_x6G_sidebarCol）。写死前缀 ⇒ 换构建即整层静默失效。
    //   后缀唯一性已全量核对：_sidebarCol / _centerCol / _rightbarCol / _composerSeat /
    //   _embeddedBody / _fade 各只对应一个前缀；_frame(11) 与 _root(44) 不唯一，
    //   分别用「包含侧栏列」与「带 data-phase」这两个结构/属性锚点区分。
    P + ' [class*="_sidebarCol"]{',
    '  background:' + SIDEBAR_FILL_LIGHT + sidebarFillAlpha() + ')!important;',
    '}',
    PD + ' [class*="_sidebarCol"]{',
    '  background:' + SIDEBAR_FILL_DARK + sidebarFillAlpha() + ')!important;',
    '}',
    // 侧栏内部的面板根（会话列表 / 文件树 / 浏览器 / 文档预览 …）：
    // 宿主在这里铺 --dsw-specific-sidebar-fill 或 --dsw-alias-bg-base，会整块盖住照片。
    // 按「列内所有 _root」统一清成 transparent ⇒ 与当前激活的是哪个面板无关。
    P + ' [class*="_sidebarCol"] [class*="_root"]{',
    '  background:transparent!important;',
    '}',
    // 会话列表底部的渐隐遮罩（<哈希>_fade，铺「透明 → 侧栏实色」渐变）——
    // 就是「左侧栏底部、账户区上方」那条渐变容器。侧栏已半透明，这截实色终点不再一致
    // ⇒ 清成 transparent。只清 background，不动 height/position
    //（它只是 pointer-events:none 的视觉遮罩，滚动与命中区不变）。
    P + ' [class*="_sidebarCol"] [class*="_fade"]{',
    '  background:transparent!important;',
    '}',
    // 侧栏右上角圆角（仅 Windows 标题栏壳）—— 与内容卡左上角 16px 圆角对称，
    // 半径直接取宿主自身的 --dsh-windows-content-radius（跟随官方值，不写死）。
    // 圆角缺口露出的是「外框背景」，而外框已被置为 transparent ⇒ 缺口处看到整屏照片。
    // 深色无需单独覆盖：本条只写 border-radius，不与深色的 background 规则冲突。
    PT + ' [class*="_sidebarCol"]{',
    '  border-radius:0 var(--dsh-windows-content-radius,16px) 0 0;',
    '}',
    // 内容列 + 右侧栏：半透明底（.86）—— 照片能透出来，正文对比度仍够用
    // (浅色 0.86×252 + 0.14×暗 ≈ 219；深色 ≈ 20；黑遮罩再兜一层对比度)
    // 右侧栏在 Windows 下宿主没有给背景，外框透明后它会直接露出照片、正文失去衬底。
    P + ' [class*="_centerCol"],',
    P + ' [class*="_rightbarCol"]{',
    '  background:rgba(252,252,253,.86)!important;',
    '}',
    PD + ' [class*="_centerCol"],',
    PD + ' [class*="_rightbarCol"]{',
    '  background:rgba(16,18,24,.86)!important;',
    '}',
    // 会话主界面根（_root[data-phase]）：宿主在此铺了不透明的 --dsw-alias-bg-base，
    // 正好整块盖住内容列；清成 transparent 后由内容列统一提供磨砂（不清理则该处永远
    // 看不到背景）。⚠️ 必须带 [data-phase]：_root 后缀全客户端有 44 个，主界面里还
    // 混着代码块 / turn 卡片这类本来就不该透明的 _root，会话根是其中唯一带该属性的。
    // 右侧栏内部的面板根同理：宿主给文件树 / 浏览器面板铺了不透明 bg-base。
    P + ' [class*="_root"][data-phase],',
    P + ' [class*="_rightbarCol"] [class*="_root"]{',
    '  background:transparent!important;',
    '}',
    // 会话输入区底座：宿主用一条渐变把底部收口到不透明 bg-base（sticky 遮住滚上来的
    // 正文）。本插件去掉这条渐变 ⇒ 底座整块 transparent，主界面从顶到底与整屏照片同透明度。
    // 宿主给「主会话根」与「内嵌会话 body」各写了一份同款渐变（条件分别是 data-phase=active
    // 与 data-content-phase=active）；底座的 _composerSeat 后缀两处相同且唯一，一条规则覆盖两种场景。
    P + ' [class*="_composerSeat"]{',
    '  background:transparent!important;',
    '}',
    // 外框透明：让整屏背景露出来。
    // ⚠️ _frame 后缀不唯一（客户端里有 11 个），不能裸用后缀；用「包含侧栏列」这个
    // 结构锚点 ⇒ [class*="_frame"]:has(…) 只会命中应用外框。（:has() 宿主自己也在用。）
    P + ' [class*="_frame"]:has([class*="_sidebarCol"]){',
    '  background:transparent!important;',
    '}',
    // Windows 桌面壳的顶栏（标题栏拖拽条）——直接显示背景图层，不铺任何半透明遮罩。
    // 宿主在顶栏这条上有两层不透明来源，缺一不可：外框 _frame 的 --dsw-specific-sidebar-fill
    //（给 padding-top 预留的顶栏高度填色），以及全宽拖拽条 _frame:before 自铺的同色底
    // —— 后者正是「顶栏被半透明遮罩盖住」的观感来源。两层都清成 transparent 后，顶栏整条
    //（含中央/右侧与内容卡 16px 圆角缺口）露出的就是 :root::before 那张照片，对比度由
    // :root::after 的黑色 .55 遮罩统一承担。
    // ⚠️ 只清 background，保留 :before 的 -webkit-app-region:drag（窗口拖拽区，宿主给的）。
    PT + ' [class*="_frame"]:has([class*="_sidebarCol"]),',
    PT + ' [class*="_frame"]:has([class*="_sidebarCol"]):before{',
    '  background:transparent!important;',
    '}',
    // Windows 标题栏（右上角最小化/最大化/关闭那条）的底色：**全透明**。
    // 这条规则**就在本页生效**：preload 建的隐藏探针 span 在本页 document.body 里
    //（实测 window === window.top、document.querySelector 直接能查到它）；preload 读它的
    // background-color 后经 dsh-desktop:windows-appearance 交给主进程 setTitleBarOverlay()。
    // Chromium 的 Window Controls Overlay 吃带 alpha 的颜色（本宿主 Electron 44 实测：
    // rgba(0,0,0,0) ⇒ 三个按钮图标直接画在网页上、底下顶栏原样透出，没有任何色带），
    // 所以这里把底色整个去掉；「采样近似色写进 <html>」那套机制已随本次修复删除。
    // ⚠️ 浅色那条写 alpha = 1/255（0.004）而不是 0，这不是笔误：
    //    宿主的颜色链路会过一次 canvas，alpha=0 时 RGB 被抹成 0（推过去就成了 rgba(0,0,0,0)，
    //    浅色兜底白留不住）；1/255 则原样保留 RGB，且与 alpha=0 实测观感完全一致
    //    （Electron 44 按钮区像素普查 6005+78 vs 6006+78）。于是「只取 RGB」的旧实现会退回
    //    白（浅色）/ 黑（深色）= 想要的兜底实色。深色那条不需要保护：黑被抹成 0 仍是黑。
    // ⚠️ 只改探针的计算后颜色，不覆盖 --dsw-specific-sidebar-fill（否则菜单/浮层一起透明）。
    // ⚠️ 这几行必须与 lib/client.js 的 OVERRIDE_CSS 逐行一致（check-css-parity.mjs 断言）。
    P + ' span[style*="--dsw-specific-sidebar-fill"]{',
    '  background-color:rgba(255,255,255,0.004)!important;',
    '}',
    PD + ' span[style*="--dsw-specific-sidebar-fill"]{',
    '  background-color:rgba(0,0,0,0)!important;',
    '}',
    // ⚠️ 图层位置（此处是首版「界面全黑」事故的根因，改动前务必读完）
    // 应用内容（外框）是 position:relative + z-index:auto，它的列是普通流内内容；
    // 因此任何"插到 #root 之后的定位于浮层"（哪怕 z-index:0）都必然绘制在整个应用之上 ——
    // 正文与侧栏会被彻底盖住（第一次事故：界面全黑、只剩背景图）。
    // 正确位置 = 挂在 html 自身堆叠上下文里的负 z-index 伪元素：
    // CSS 2.1 附录 E 的绘制顺序是「根背景 → 负 z 层 → 流内内容」。
    // 同一个 z-index:-1 ⇒ ::before（照片/渐变）与 ::after（遮罩）同层，靠树序压栈，遮罩在上。
    // ⚠️ 但 body 的背景属于「流内内容」这一步，会盖住负 z 层 ——
    // body{background-color:transparent} 是这条链路唯一承重的规则，不能删。
    P + ' body{',
    '  background-color:transparent!important;',
    '}',
    // 背景层：底色 + 服务器照片（没有照片时回落到渐变）
    P + '::before{',
    '  content:"";',
    '  position:fixed;',
    '  inset:0;',
    '  z-index:-1;',
    '  pointer-events:none;',
    '  background-color:#0d1017;',
    '  background-image:var(' + PHOTO_VAR + ',' + DEFAULT_BACKDROP_CSS + ');',
    '  background-position:center;',
    '  background-size:cover;',
    '  background-repeat:no-repeat;',
    '}',
    // 半透明黑遮罩（恒定黑色，语义同 Kirara 的 HomeOverlay）
    // 同为 z-index:-1 → 与背景层同层，靠树序压在 ::before 之上
    P + '::after{',
    '  content:"";',
    '  position:fixed;',
    '  inset:0;',
    '  z-index:-1;',
    '  pointer-events:none;',
    '  background:rgba(0,0,0,.55);',
    '}',
    // 无障碍：系统要求降低透明度时全部退回不透明
    // 放最后 + 深色变体一并列出 —— 只写浅色前缀压不过上面的深色规则（特异度更高）。
    // 承担「露出照片」的每一层都要在这里换回实色：三个列 / 顶栏（外框 + 拖拽条）/ 标题栏（探针）/ 输入区底座。
    // 内层（侧栏面板根 / 会话根）始终透明。
    '@media (prefers-reduced-transparency:reduce){',
    '  ' + P + ' [class*="_sidebarCol"],',
    '  ' + PT + ' [class*="_frame"]:has([class*="_sidebarCol"]),',
    '  ' + PT + ' [class*="_frame"]:has([class*="_sidebarCol"]):before,',
    '  ' + P + ' span[style*="--dsw-specific-sidebar-fill"]{',
    '    background:var(--dsw-specific-sidebar-fill)!important;',
    '  }',
    '  ' + PD + ' span[style*="--dsw-specific-sidebar-fill"]{',
    '    background:var(--dsw-specific-sidebar-fill)!important;',
    '  }',
    '  ' + P + ' [class*="_centerCol"],',
    '  ' + P + ' [class*="_rightbarCol"]{',
    '    background:var(--dsw-alias-bg-base)!important;',
    '  }',
    '  ' + PD + ' [class*="_sidebarCol"],',
    '  ' + PTD + ' [class*="_frame"]:has([class*="_sidebarCol"]),',
    '  ' + PTD + ' [class*="_frame"]:has([class*="_sidebarCol"]):before{',
    '    background:var(--dsw-specific-sidebar-fill)!important;',
    '  }',
    '  ' + PD + ' [class*="_centerCol"],',
    '  ' + PD + ' [class*="_rightbarCol"]{',
    '    background:var(--dsw-alias-bg-base)!important;',
    '  }',
    '}',
  ].concat(photo ? [photo] : []).join('\n');
}

/** 首屏注入的全局配置（与 `dsh-client-ui-theme` 的 boot script 同思路）。 */
function bootGlobal(config) {
  const snapshot = publicState(config);
  return {
    routePath: snapshot.routePath,
    imageUrl: snapshot.imageUrl,
    isDefault: snapshot.isDefault,
    version: snapshot.version,
    backdrop: DEFAULT_BACKDROP_CSS,
  };
}

function apply(ctx, config) {
  /** 生效配置（补齐默认值，避免 bundle 只给部分字段时炸掉）。 */
  const resolved = {
    ...config,
    enabled: config.enabled !== false,
    apiBaseUrl: typeof config.apiBaseUrl === 'string' ? config.apiBaseUrl : DEFAULT_API_BASE_URL,
    endpoint: typeof config.endpoint === 'string' ? config.endpoint : DEFAULT_ENDPOINT,
    routePath: normalizeRoutePath(config.routePath || DEFAULT_ROUTE_PATH),
    syncIntervalMinutes:
      Number(config.syncIntervalMinutes) > 0
        ? Number(config.syncIntervalMinutes)
        : DEFAULT_SYNC_INTERVAL_MINUTES,
    requestTimeoutMs:
      Number(config.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS,
    cacheDir: typeof config.cacheDir === 'string' ? config.cacheDir : '',
  };

  state.cacheDir = resolveCacheDir(resolved.cacheDir);

  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      // 启动流程：先读本地缓存（离线也有图）→ 启动后台同步 → 注册路由与首屏注入。
      let disposed = false;

      const boot = (async () => {
        try {
          await fsp.mkdir(state.cacheDir, { recursive: true });
        } catch {
          /* 目录不可建也不致命 */
        }
        await restoreFromDisk();
        if (disposed) return;
        // 不 await：首屏不等网络。
        void syncOnce(resolved).catch(() => {});
      })();

      const disposeRoute = child.webServer.register({
        kind: 'prefix',
        path: resolved.routePath,
        handler: createRouteHandler(resolved),
      });

      const disposeInject = child.on('webserver/index-inject', (table) => {
        // 无闪白：先给底色与背景层，再让客户端半边接管交叉淡入与主题联动。
        table.push({ kind: 'global', name: GLOBAL_KEY, value: bootGlobal(resolved) });
        // ⚠️ 首屏样式带 BOOT_MARKER：运行时关闭插件时，客户端半边凭它把这一份
        //    已经写进索引页的样式一并摘掉（否则关掉插件后外观不消失，见 BOOT_MARKER 注释）。
        table.push({ kind: 'style', text: BOOT_MARKER + '\n' + bootCss(resolved) });
      });

      const intervalMs = Math.max(60_000, resolved.syncIntervalMinutes * 60_000);
      const timer = setInterval(() => {
        void ensureSynced(resolved).catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();

      return () => {
        disposed = true;
        clearInterval(timer);
        disposeInject();
        disposeRoute();
        void boot.catch(() => {});
      };
    }, 'kirara-theme:background');
  });
}

export { Config, apply };
