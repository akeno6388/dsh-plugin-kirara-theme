#!/usr/bin/env node
/**
 * 首屏 CSS 同源校验（只读）。
 *
 * 本插件的外观规则写了两遍：
 *   - 宿主半边 `lib/index.js` 的 `bootCss()`：客户端脚本执行**之前**注入，用裸 `:root` 前缀；
 *   - 客户端半边 `lib/client.js` 的 `OVERRIDE_CSS`：写在 `data-kirara-theme` 就绪之后。
 * 两者除「选择器前缀」与「`--kirara-theme-photo` 首屏取图行」外必须**逐条一致**，
 * 否则脚本接手的一瞬间会出现样式漂移（闪帧）。README §4.2 把这条列为硬约束，
 * 但此前只能靠人工比对 —— 本脚本把「人工比对」变成可执行断言。
 *
 * 做法：直接从两份源码里把规则数组的**字面量片段**取出来求值（不加载宿主包），
 * 再把客户端前缀规范化成裸 `:root` 形式，逐行比对。
 *
 * ⚠️ 另外断言一组「参与拼接、但不在 CSS 字面量里」的参数常量（侧栏透明度那三个）
 * 在两个文件里取值相同 —— 只比对渲染结果**抓不到**这种漂移（详见 `compareSidebarConsts()`）。
 *
 * 用法：
 *   node scripts/check-css-parity.mjs        # 一致 → 退出码 0；有漂移 → 退出码 1
 *   node scripts/check-css-parity.mjs --dump # 额外打印首屏（宿主）渲染出的完整 CSS
 *
 * 也被 `scripts/deploy.mjs` 当不变量复用（`import { compareCssParity }`），
 * 所以本文件只在「直接执行」时才走命令行分支。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));
const HTML_ATTR = 'data-kirara-theme';
const PHOTO_VAR = '--kirara-theme-photo';
const FALLBACK_PHOTO = 'linear-gradient(135deg,#1b2030 0%,#0d1017 60%,#080a10 100%)';

/** 客户端前缀（与 lib/client.js 顶部同名变量保持一致）。 */
const CLIENT_PREFIXES = {
  P: `:root[${HTML_ATTR}]`,
  PD: `:root[${HTML_ATTR}] body[data-ds-dark-theme]`,
  PT: `:root[data-windows-titlebar][${HTML_ATTR}]`,
  PTD: `:root[data-windows-titlebar][${HTML_ATTR}] body[data-ds-dark-theme]`,
};
/** 宿主前缀（与 lib/index.js 的 bootCss() 内部一致）。 */
const HOST_PREFIXES = {
  P: ':root',
  PD: ':root body[data-ds-dark-theme]',
  PT: ':root[data-windows-titlebar]',
  PTD: ':root[data-windows-titlebar] body[data-ds-dark-theme]',
};

function sliceBetween(source, from, to, label) {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`${label}: 找不到起点 ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`${label}: 找不到终点 ${JSON.stringify(to)}`);
  return source.slice(start, end + to.length);
}

/**
 * 从源码里取一个字面量常量（`const NAME = ...;` 或 `var NAME = ...;`，允许行首缩进）。
 *
 * 宿主半用 `const`（模块顶层），客户端半用 `var`（包在 IIFE 里），两种都收。
 */
function readConst(source, name, label) {
  const match = source.match(new RegExp(`^[ \\t]*(?:const|var) ${name} = (.+?);$`, 'm'));
  if (!match) throw new Error(`${label}: 找不到常量 ${name}`);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${match[1]});`)();
}

/** 侧栏透明度相关的常量名（宿主与客户端必须各自声明且取值一致）。 */
const SIDEBAR_CONSTS = ['SIDEBAR_ALPHA', 'SIDEBAR_FILL_LIGHT', 'SIDEBAR_FILL_DARK'];

/**
 * 求出「写进 CSS 的侧栏实心度」= `Math.round((1 - SIDEBAR_ALPHA) * 1000) / 1000`。
 *
 * 与两个半边各自的 `sidebarFillAlpha()` **必须同式**。这里复刻它（而不是从源码里抠），
 * 是因为它参与字符串拼接：只要两边算式一致，逐行比对就能真正抓到数值差异。
 * 若改了两边的取整精度，这里也要一起改。
 *
 * ⚠️ 注入沙箱时**必须把 alpha 绑进去**（见 `boundFillAlpha`）——源码里的调用是零参
 * `sidebarFillAlpha()`，把本体直接塞进去会拿到 `NaN`，拼出 `rgba(...,NaN)`。
 * 而那种错误**两边会同时犯**，逐行比对反而认为是「同源」，所以下面额外断言结果不是 NaN。
 */
function sidebarFillAlpha(alpha) {
  return Math.round((1 - alpha) * 1000) / 1000;
}

/** 供沙箱使用的零参版本（把 alpha 闭包进去）。 */
function boundFillAlpha(alpha) {
  return function sidebarFillAlphaBound() {
    return sidebarFillAlpha(alpha);
  };
}

/**
 * 断言拼出来的 CSS 里没有 `NaN`。
 *
 * 这是上一条注释里那个陷阱的守卫：`rgba(249,250,252,NaN)` 是**无效声明**，浏览器会丢弃它
 * ⇒ 侧栏直接没有底色（露出整屏照片，正文糊掉）。而它又「两边一致」，
 * 所以必须单独用「结果是否合法」来兜，而不是靠比对。
 */
function assertNoNaN(css, label) {
  if (css.includes('NaN')) {
    throw new Error(`${label}: 渲染结果里出现 NaN（多为 sidebarFillAlpha 未绑定 alpha 所致）`);
  }
  return css;
}

/**
 * 校验宿主与客户端里那组「影响颜色但不在 CSS 字面量里」的常量是否一致。
 *
 * ⚠️ 这是本脚本存在意义的延伸：只比对渲染结果**抓不到**这种漂移 ——
 * `'rgba(249,250,252,' + sidebarFillAlpha(x) + ')'` 两边拼出来的**形状**一样，
 * 若一边写 0.42、另一边写 0.30，逐行比对仍然通过，但首屏与客户端颜色已经不同。
 */
export function compareSidebarConsts() {
  const clientSource = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8');
  const hostSource = readFileSync(join(pluginDir, 'lib', 'index.js'), 'utf8');
  const mismatches = [];
  for (const name of SIDEBAR_CONSTS) {
    const clientValue = readConst(clientSource, name, 'lib/client.js');
    const hostValue = readConst(hostSource, name, 'lib/index.js');
    if (clientValue !== hostValue) {
      mismatches.push({ name, host: hostValue, client: clientValue });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** 求出客户端 `OVERRIDE_CSS` 的最终文本。 */
function clientCss() {
  const source = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8');
  const fragment = sliceBetween(source, 'var OVERRIDE_CSS = [', '].join("\\n");', 'lib/client.js');
  const evaluate = new Function(
    'HTML_ATTR',
    'PHOTO_VAR',
    'FALLBACK_PHOTO',
    'P',
    'PD',
    'PT',
    'PTD',
    'SIDEBAR_FILL_LIGHT',
    'SIDEBAR_FILL_DARK',
    'sidebarFillAlpha',
    `${fragment}\nreturn OVERRIDE_CSS;`,
  );
  return assertNoNaN(
    evaluate(
      HTML_ATTR,
      PHOTO_VAR,
      FALLBACK_PHOTO,
      CLIENT_PREFIXES.P,
      CLIENT_PREFIXES.PD,
      CLIENT_PREFIXES.PT,
      CLIENT_PREFIXES.PTD,
      readConst(source, 'SIDEBAR_FILL_LIGHT', 'lib/client.js'),
      readConst(source, 'SIDEBAR_FILL_DARK', 'lib/client.js'),
      boundFillAlpha(readConst(source, 'SIDEBAR_ALPHA', 'lib/client.js')),
      `${fragment}\nreturn OVERRIDE_CSS;`,
    ),
    'lib/client.js',
  );
}

/** 求出宿主 `bootCss()` 的最终文本（`photo` 取 null ⇒ 不带首屏取图行）。 */
function hostCss() {
  const source = readFileSync(join(pluginDir, 'lib', 'index.js'), 'utf8');
  const bootStart = source.indexOf('function bootCss(config)');
  if (bootStart < 0) throw new Error('lib/index.js: 找不到 bootCss()');
  const photoVar = readConst(source, 'PHOTO_VAR', 'lib/index.js');
  const backdrop = readConst(source, 'DEFAULT_BACKDROP_CSS', 'lib/index.js');
  const returnAt = source.indexOf('return [\n', bootStart);
  if (returnAt < 0) throw new Error('lib/index.js: bootCss() 里找不到 `return [`');
  const tail = '].concat(photo ? [photo] : [])';
  const end = source.indexOf(tail, returnAt);
  if (end < 0) throw new Error(`lib/index.js: bootCss() 里找不到 ${JSON.stringify(tail)}`);
  const expression = source.slice(returnAt + 'return '.length, end + tail.length);
  const evaluate = new Function(
    'P',
    'PD',
    'PT',
    'PTD',
    'photo',
    'PHOTO_VAR',
    'DEFAULT_BACKDROP_CSS',
    'SIDEBAR_FILL_LIGHT',
    'SIDEBAR_FILL_DARK',
    'sidebarFillAlpha',
    `return (${expression}).join("\\n");`,
  );
  return assertNoNaN(
    evaluate(
      HOST_PREFIXES.P,
      HOST_PREFIXES.PD,
      HOST_PREFIXES.PT,
      HOST_PREFIXES.PTD,
      null,
      photoVar,
      backdrop,
      readConst(source, 'SIDEBAR_FILL_LIGHT', 'lib/index.js'),
      readConst(source, 'SIDEBAR_FILL_DARK', 'lib/index.js'),
      boundFillAlpha(readConst(source, 'SIDEBAR_ALPHA', 'lib/index.js')),
      `return (${expression}).join("\\n");`,
    ),
    'lib/index.js',
  );
}

/** 把客户端前缀规范化成裸 `:root` 形式（长前缀先替换）。 */
function normalize(css) {
  return css
    .split(CLIENT_PREFIXES.PTD)
    .join(HOST_PREFIXES.PTD)
    .split(CLIENT_PREFIXES.PT)
    .join(HOST_PREFIXES.PT)
    .split(CLIENT_PREFIXES.PD)
    .join(HOST_PREFIXES.PD)
    .split(CLIENT_PREFIXES.P)
    .join(HOST_PREFIXES.P);
}

/** 比对两份 CSS 是否同源。抛错表示「源码结构变了，脚本取不到数组」（视为失败）。 */
export function compareCssParity() {
  // 先验参数常量：两边数字不同也会渲染出「形状相同」的 CSS，逐行比对抓不到。
  const consts = compareSidebarConsts();
  const host = hostCss();
  const client = normalize(clientCss());
  const hostLines = host.split('\n').map((line) => line.replace(/^ {2}/, ''));
  const clientLines = client.split('\n').map((line) => line.replace(/^ {2}/, ''));
  const diffs = [];
  const max = Math.max(hostLines.length, clientLines.length);
  for (let i = 0; i < max; i += 1) {
    if (hostLines[i] !== clientLines[i]) {
      diffs.push({ line: i + 1, host: hostLines[i], client: clientLines[i] });
    }
  }
  return {
    ok: diffs.length === 0 && consts.ok,
    lines: hostLines.length,
    diffs,
    host,
    constMismatches: consts.mismatches,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (!invokedDirectly) {
  // 被 import 时只导出函数，不产生任何副作用。
} else {
  let report;
  try {
    report = compareCssParity();
  } catch (error) {
    console.log(`✗ 首屏 CSS 同源校验无法执行：${error.message}`);
    process.exit(1);
  }

  if (process.argv.includes('--dump')) {
    console.log('--- 首屏（宿主 bootCss）渲染结果 ---');
    console.log(report.host);
    console.log('--- 首屏渲染结果结束 ---');
  }

  if (report.ok) {
    console.log(`✓ 首屏 CSS 同源（${report.lines} 行，前缀规范化后逐行一致；侧栏参数常量亦一致）`);
    process.exit(0);
  }

  if (report.constMismatches.length > 0) {
    console.log('✗ 侧栏参数常量在两个文件里不一致（渲染形状相同，但实际颜色已漂移）：');
    for (const item of report.constMismatches) {
      console.log(
        `    ${item.name}: 宿主 = ${JSON.stringify(item.host)} / 客户端 = ${JSON.stringify(item.client)}`,
      );
    }
  }

  if (report.diffs.length > 0) {
    console.log(
      `✗ 首屏 CSS 漂移：lib/index.js 的 bootCss() 与 lib/client.js 的 OVERRIDE_CSS 有 ${report.diffs.length} 处不一致`,
    );
    for (const diff of report.diffs.slice(0, 20)) {
      console.log(`  第 ${diff.line} 行`);
      console.log(`    宿主 : ${JSON.stringify(diff.host)}`);
      console.log(`    客户端: ${JSON.stringify(diff.client)}`);
    }
    if (report.diffs.length > 20) console.log(`  …（其余 ${report.diffs.length - 20} 处省略）`);
  }
  process.exit(1);
}
