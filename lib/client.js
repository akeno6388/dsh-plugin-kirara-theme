/**
 * @kirara/dsh-plugin-kirara-theme — 浏览器半边（DSH Web/桌面 GUI 外观层）
 * ============================================================================
 *
 * 这是 DSH 客户端插件的 **经典脚本** 产物（不是 ESM）：
 *   - 整段代码包在一个 IIFE 里；
 *   - 内部**恰好一次** `window.__ModuleLoader__.load(...)` 调用；
 *   - `id` 必须等于包名（`@kirara/dsh-plugin-kirara-theme`）；
 *   - 不使用 import / export，依赖通过 factory 的 `require` 参数取。
 *
 * 宿主半边（lib/index.js）已经完成了全部网络工作：
 *   1. 跟随 302 预签名跳转下载服务器背景图；
 *   2. 用 `X-Resource-Version` / `ETag` 做版本比对（版本未变则零下载）；
 *   3. 落盘缓存（`background.bin` + `state.json`），重启后可直接复用；
 *   4. 通过 `webserver/index-inject` 往首页 HTML 注入：
 *        - 一条 `global` 行 → `window.__KIRARA_THEME__`（首帧即可用）；
 *        - 一条 `style` 行 → 与本文件 `OVERRIDE_CSS` **逐字节一致**的外观 CSS（防闪白）；
 *   5. 在同源上暴露路由：
 *        GET  <routePath>/state.json      → 状态（版本号 / 是否有图 / 是否内置默认）
 *        GET  <routePath>/background      → 302 到默认图，或 200 返回真实背景图字节
 *        POST <routePath>/refresh         → 强制重新同步
 *
 * 浏览器半边只做三件事：
 *   A. 注入/回收外观 CSS（侧栏与内容区半透明、标题栏条、背景板、遮罩）；
 *   B. 把服务器照片写进 `<html>` 上的自定义属性 `--kirara-theme-photo`
 *      （CSS 里由 `:root[...]::before` 消费；先 new Image() 解码成功再落值，
 *       所以不会出现「半张图」的中间态）；
 *   C. 轮询 `state.json`，版本变化时才去换图（与服务端 30 分钟节流语义对齐）。
 *
 * 为什么不用 slot 挂载？
 *   Web shell 只注册了 `root` 一个 slot，`#root` 里只有 AppFrame，
 *   纯 slot 挂载无法把图层放到最底层。
 *
 * 为什么背景层必须挂在 `html` 的伪元素上（★ 血泪教训，别改）？
 *   应用内容（应用外框，`.<哈希前缀>_frame`）是 `position:relative` + `z-index:auto` 的定位元素，
 *   任何 `position:fixed` 且 z-index >= 0 的节点只要插在 `#root` 之后，
 *   都会绘制在**整个应用之上**（首版「界面全黑、文字与侧栏不可见」的根因），
 *   z-index:0 也一样。唯一安全的位置是 `html` 自身堆叠上下文里的
 *   **负 z-index 伪元素**：绘制在根背景之后、所有在流内容之前；
 *   同为 -1 的 ::before / ::after 按树序叠放（遮罩在上）。
 *   代价：必须把 `body` 的底色改成透明，否则 body 的背景会盖住它们。
 *
 * 因此本文件对 DOM 的写入是**幂等且可完全回滚**的：
 *   - 只写一个 `<style>`（必须同时带 data-plugin / data-plugin-css，
 *     缺任何一个 `dsh-client-modules` 卸载时都无法回收）；
 *   - 只往 `<html>` 写两个属性：标记属性 `data-kirara-theme` 与
 *     自定义属性 `--kirara-theme-photo`；
 *   - 卸载 = 移除 <style> + 摘掉这两个属性，**不插入任何元素节点**。
 */

(function () {
  "use strict";

  var PLUGIN_NAME = "@kirara/dsh-plugin-kirara-theme";
  var CSS_ID = PLUGIN_NAME + "/client.css";
  var GLOBAL_KEY = "__KIRARA_THEME__";
  var HTML_ATTR = "data-kirara-theme";
  /**
   * 宿主注入的首屏样式表里那个标记注释（**必须与 `lib/index.js` 的 `BOOT_MARKER` 逐字节一致**）。
   *
   * 为什么客户端要认识它：`webserver/index-inject` 只在渲染索引页时 emit 一次，
   * 那一行 `<style>` 写进 HTML 后就永久留在文档里 —— 运行时把插件关掉时，
   * 宿主半边只能「以后不再注入」，摘不掉已经送进浏览器的那一份。
   * 不摘的后果：关掉插件后整套外观还在（背景、遮罩、半透明列全都留着），
   * 只有刷新页面才会消失。卸载时按这个标记把首屏样式一并移除，外观即刻还原。
   */
  var BOOT_MARKER = "/*! kirara-theme-boot */";
  // 服务器照片走自定义属性（不是 DOM 节点），由 `:root[...]::before` 消费。
  var PHOTO_VAR = "--kirara-theme-photo";
  // 与宿主 `lib/index.js` 的 DEFAULT_BACKDROP_CSS **必须逐字节一致**（README §4.2）。
  var FALLBACK_PHOTO =
    "linear-gradient(135deg,#1b2030 0%,#0d1017 60%,#080a10 100%)";

  var DEFAULT_ROUTE_PATH = "/kirara-theme";
  var FIRST_POLL_WINDOW_MS = 60000;
  var FAST_POLL_MS = 10000;
  var SLOW_POLL_MS = 180000;
  /** 暖机窗口：挂载后这段时间内「还没图」就按 WARMUP_RETRY_MS 快试。 */
  var WARMUP_MS = 30000;
  /** 暖机期的重试间隔（宿主可能还在读盘 / 第一次同步）。 */
  var WARMUP_RETRY_MS = 1500;

  /* ------------------------------------------------------------------ *
   * 外观 CSS —— 与宿主 lib/index.js 的 bootCss() 必须保持一致
   *
   * 设计约束（改动前务必确认）：
   *  1. **不覆盖 `--dsw-specific-sidebar-fill`**：该 token 同时被菜单、
   *     弹出层、`--dsw-alias-button-elevated-fill` 系列复用，改它会让
   *     所有浮层一起变半透明。这里只给两个侧栏容器元素铺半透明底。
   *  2. **不用 backdrop-filter**：Kirara 首页没有任何亚克力/模糊，
   *     整屏照片已经盖住了窗口级 Mica。
   *  3. **不用 color-mix / @supports**：统一写死 rgba()，宿主注入的
   *     首帧 CSS 与这里才能逐字节对齐，也避开旧 Chromium 的解析差异。
   *  4. **绝不写 `color`**：任何落在 body/html 上的 `!important` 颜色都会被
   *     所有子元素继承，直接把整个 harness 的文字与图标染成同色 —— 这是
   *     第二个事故（「只剩背景图，内部 UI 全看不见」）的根因。要引用的
   *     token 名也必须是真名（正文主色是 `--dsw-alias-label-primary`；
   *     `--dsw-alias-text-primary` 在 theme-client 里根本不存在，
   *     写错的 token 会静默退化成字面量兜底色）。
   *  5. 主题只认 `body[data-ds-dark-theme]`（存在 = 深色，不存在 = 浅色）。
   *     ⚠️ 属性挂在 **body** 上，深色变体必须写成
   *     `:root[data-kirara-theme] body[data-ds-dark-theme] …`；
   *     写成 `:root[data-kirara-theme][data-ds-dark-theme]` 永不匹配。
   *  6. 每条选择器都带 `:root[data-kirara-theme]` 前缀，让特异度达到
   *     (0,2,0) 稳定压过布局层 (0,1,0)，与注入顺序无关。
   *  7. ★ **选择器只写 CSS Modules 的「本地名后缀」，绝不写哈希前缀**
   *     （写 `[class*="_sidebarCol"]`，不写 `.BynINW_sidebarCol`）。
   *     `.module.css` 编译出来的类名是 `<哈希前缀>_<本地名>`：本地名来自源码、
   *     跨宿主版本稳定，哈希前缀**每次构建都可能变** —— 官方 0.2.0-rc.2 是
   *     `.BynINW_sidebarCol`，EduWork 内置的新版 DSH 把同一份源码编译成
   *     `.pI_x6G_sidebarCol`。写死前缀 ⇒ 换一个宿主构建就整层静默失效
   *     （症状：照片被宿主的不透明列与面板盖死、三列都不透明）。
   *
   *     后缀唯一性已在客户端全量核对：`_sidebarCol` / `_centerCol` /
   *     `_rightbarCol` / `_composerSeat` / `_embeddedBody` / `_fade`
   *     各只对应一个前缀 ⇒ 可以安全地只按后缀匹配；`_frame`（11 个）与
   *     `_root`（44 个）不唯一 ⇒ 用「结构 / 属性」锚点区分：
   *       · 外框    = 唯一「包含侧栏列」的 `_frame`（`:has()`，宿主自己也在用）；
   *       · 会话根  = 唯一带 `data-phase` 的 `_root`（宿主 CSS 用的是同一依据）；
   *       · 侧栏 / 右侧栏内的面板根 = 该列内部**全部** `_root` —— 宿主把侧栏拆成了
   *         多个可切换面板、每个面板自带一个 `_root`，逐个点名只是把哈希依赖换个
   *         地方放。菜单与浮层走 `createPortal(…, document.body)`，落在列之外，
   *         不受这几条影响（否则会把菜单一起变透明 —— 第 1 条的雷）。
   *     失效后果是「该处不再半透明 / 圆角消失」，不会破坏布局，可接受。
   *  8. **磨砂只能由「列」承担**：宿主在侧栏内部的每个面板根（铺
   *     `--dsw-specific-sidebar-fill` / `--dsw-alias-bg-base`）与会话主界面根
   *     （铺 `--dsw-alias-bg-base`）上各自铺了不透明底。插件若只改列的颜色，
   *     内层实色会把照片彻底挡住（＝「主界面看不到背景」的根因）；两层同色
   *     半透明叠加则会反向推回近乎实心（0.58 叠 0.58 ≈ 0.82）。
   *     因此内层的实色底必须显式清成 transparent，透明度只在列上设定一次。
   *  9. **Windows 顶栏是「零透明度」的唯一例外**：顶栏那条不设任何透明度，
   *     直接 transparent 露出背景图层。宿主在顶栏上有**两层**不透明来源，
   *     少清一层就剩一层：外框 `_frame`（`padding-top` 预留的顶栏高度，
   *     填的是 `--dsw-specific-sidebar-fill`）与外框 `_frame:before`
   *     （`height:var(--dsh-windows-titlebar-height)` 的全宽拖拽条，自己又铺了一层
   *     同色底 —— 这就是「顶栏被半透明遮罩盖住」的观感来源）。两者的症状都是
   *     「顶栏比下方内容区更亮」。
   *     ⚠️ 只清 `background`，**保留 `:before` 的 `-webkit-app-region:drag`**
   *     （窗口拖拽几何是宿主给的，改了窗口就拖不动）。
   *     ⚠️ 顶栏那条选择器带 `:has([class*="_sidebarCol"])`，特异度高于宿主自身的
   *     `[data-windows-titlebar] <哈希>_frame`；所以这里把外框与 `:before`
   *     写进**同一条规则**显式声明，不依赖「作者样式表内后者胜」这种顺序
   *     （不写也能靠早前那条通用外框规则兜底，但那一条与宿主是打平的）。
   *     与第 1 条不冲突：清的是具体元素上的声明，没有动 token 本身，浮层不受影响。
   * ------------------------------------------------------------------ */
  // 选择器前缀：浅色 / 深色 / Windows 标题栏壳（浅色、深色）
  var P = ":root[" + HTML_ATTR + "]";
  var PD = P + " body[data-ds-dark-theme]";
  var PT = ":root[data-windows-titlebar][" + HTML_ATTR + "]";
  var PTD = PT + " body[data-ds-dark-theme]";

  /**
   * 侧栏列的**透明度**（★ 注意语义：0 = 完全不透明，1 = 完全透明）。
   *
   * 刻意用「透明度」而不是「不透明度」命名 —— 避免这类经典反转错误：
   * 想更透，却把 `rgba(...,.72)` 的手写值改成 `.85`（那反而更实心）。
   * 写进 CSS 的实心度是 `1 - 本值`。
   *
   * ⚠️ 必须与 `lib/index.js` 的 `SIDEBAR_ALPHA` 逐字节一致（首屏/客户端 CSS 同源契约，
   * 由 `scripts/check-css-parity.mjs` 断言）。改动时两个文件一起改。
   */
  var SIDEBAR_ALPHA = 0.42;
  /** 侧栏列底色（浅色 / 深色），alpha 由 `SIDEBAR_ALPHA` 决定。 */
  var SIDEBAR_FILL_LIGHT = "rgba(249,250,252,";
  var SIDEBAR_FILL_DARK = "rgba(20,22,28,";
  /**
   * 把 `SIDEBAR_ALPHA` 换算成写进 CSS 的**实心度**（= 1 - 透明度），并去掉浮点毛刺。
   * 取整原因与「两边必须逐字节一致」的要求见 `lib/index.js` 同名函数。
   */
  function sidebarFillAlpha() {
    return Math.round((1 - SIDEBAR_ALPHA) * 1000) / 1000;
  }

  var OVERRIDE_CSS = [
    /* ------------------------------------------------------------------ *
     * ★ 选择器约定（v0.2.0 起）：只按 CSS Modules 的「本地名后缀」匹配，绝不写哈希前缀。
     *
     * .module.css 编译出来的类名形如 `<哈希前缀>_<本地名>`：
     *   - 本地名（sidebarCol / centerCol / frame / root …）来自源码，
     *     换宿主版本、换构建都稳定；
     *   - 哈希前缀每次构建都可能变 —— 官方 0.2.0-rc.2 出的是 .BynINW_sidebarCol，
     *     EduWork 内置的新版 DSH 里同一份源码编译成 .pI_x6G_sidebarCol。
     * 写死前缀 ⇒ 换一个宿主构建就整层静默失效（症状：照片被宿主的不透明列与
     * 面板盖死、三列都不透明），所以这里一律用 [class*="_本地名"]。
     *
     * 后缀唯一性已在客户端全量核对：
     *   _sidebarCol / _centerCol / _rightbarCol / _composerSeat / _embeddedBody
     *   / _fade 各只对应一个前缀 ⇒ 可以安全地只按后缀匹配；
     *   _frame（11 个）与 _root（44 个）不唯一 ⇒ 用「结构 / 属性」锚点区分：
     *     · 外框     = 唯一「包含侧栏列」的 _frame（:has()，宿主自己也在用）；
     *     · 会话根   = 唯一带 data-phase 的 _root（宿主 CSS 用的是同一依据）；
     *     · 侧栏 / 右侧栏内的面板根 = 该列内部**全部** _root —— 新版本把侧栏拆成
     *       多个可切换面板、每个面板自带一个 _root，逐个点名只是把哈希依赖换个
     *       地方放。菜单与浮层走 createPortal(…, document.body)，落在列之外，
     *       不受这三条影响（否则会把菜单一起变透明 —— 约束 1 的雷）。
     * ------------------------------------------------------------------ */

    /* 侧栏列：半透明底
     * 磨砂只由列承担（约束 8）—— 侧栏内部面板根的实色底必须清掉，
     * 否则两层同色半透明叠加会把侧栏推回 ≈0.92 实心。 */
    P + ' [class*="_sidebarCol"]{',
    '  background:' + SIDEBAR_FILL_LIGHT + sidebarFillAlpha() + ')!important;',
    '}',
    PD + ' [class*="_sidebarCol"]{',
    '  background:' + SIDEBAR_FILL_DARK + sidebarFillAlpha() + ')!important;',
    '}',

    /* 侧栏内部的面板根（会话列表 / 文件树 / 浏览器 / 文档预览 …）：宿主在这里铺
     * --dsw-specific-sidebar-fill（侧栏自身）或 --dsw-alias-bg-base（各面板），
     * 会整块盖住照片。按「列内所有 _root」统一清成 transparent ⇒ 与当前激活的是
     * 哪个面板无关，也不依赖面板的哈希前缀。 */
    P + ' [class*="_sidebarCol"] [class*="_root"]{',
    '  background:transparent!important;',
    '}',

    /* 会话列表底部的渐隐遮罩（<哈希>_fade，24px，absolute bottom:0，铺的是
     * linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill))）
     * —— 它就是「左侧栏底部、账户区上方」那条渐变容器。
     * 语义上它属于「不透明侧栏」时代：列表滚到底时用一截实色把文字压掉。
     * 侧栏已经是半透明照片，这截实色终点与整块面板不再一致 ⇒ 去成 transparent。
     * ⚠️ 不要改它的 height / position：它只是视觉遮罩（pointer-events:none），
     * 清掉底色后列表滚动与命中区完全不变。
     * （宿主自己也认为它不适合透明场景：darwin 下直接 display:none。） */
    P + ' [class*="_sidebarCol"] [class*="_fade"]{',
    '  background:transparent!important;',
    '}',

    /* 侧栏右上角圆角（仅 Windows 标题栏壳）—— 与内容卡左上角 16px 圆角对称，
     * 半径直接取宿主自身的 --dsh-windows-content-radius（跟随官方值，不写死）。
     * 圆角缺口露出的是「外框背景」，而外框已被置为 transparent ⇒ 缺口处看到整屏照片。
     * 深色无需单独覆盖：本条只写 border-radius，不与深色的 background 规则冲突。 */
    PT + ' [class*="_sidebarCol"]{',
    '  border-radius:0 var(--dsh-windows-content-radius,16px) 0 0;',
    '}',

    /* 内容列 + 右侧栏：半透明底（.86）—— 照片能透出来，正文对比度仍够用
     * （浅色 0.86×252 + 0.14×暗 ≈ 219；深色 ≈ 20；黑遮罩再兜一层对比度）
     * 右侧栏在 Windows 下宿主**没有**给背景（原生就显得与内容列一体），
     * 外框透明后它会直接露出照片、正文失去衬底 —— 这里补上同款磨砂。 */
    P + ' [class*="_centerCol"],',
    P + ' [class*="_rightbarCol"]{',
    '  background:rgba(252,252,253,.86)!important;',
    '}',
    PD + ' [class*="_centerCol"],',
    PD + ' [class*="_rightbarCol"]{',
    '  background:rgba(16,18,24,.86)!important;',
    '}',

    /* 会话主界面根（_root[data-phase]）：宿主在此铺了**不透明**的
     * --dsw-alias-bg-base，正好整块盖住内容列 —— 不清掉它就永远只能看到纯色
     * 主界面（「主界面看不到背景」的根因）。清成 transparent 后由内容列统一
     * 提供磨砂。
     * ⚠️ 为什么带 [data-phase]：_root 后缀全客户端有 44 个，主界面里还混着
     * 代码块、turn 卡片这类**本来就不该透明**的 _root。会话根是其中唯一带
     * data-phase 的那一个（宿主自己的 CSS 就是靠 .<哈希>_root[data-phase=…]。）
     * 右侧栏内部的面板根同理：宿主给文件树 / 浏览器面板铺了不透明 bg-base。 */
    P + ' [class*="_root"][data-phase],',
    P + ' [class*="_rightbarCol"] [class*="_root"]{',
    '  background:transparent!important;',
    '}',

    /* 会话输入区底座：宿主用一条渐变把底部收口到**不透明** bg-base
     * （sticky 遮住滚上来的正文）。本插件要去掉这条渐变：底座整块 transparent，
     * 主界面从顶到底与整屏照片同透明度，不再出现「下方越往下越实」的渐隐带。
     * 宿主给「主会话根」和「内嵌会话 body」各写了一份同款渐变（条件分别是
     * data-phase=active 与 data-content-phase=active）—— 底座的 _composerSeat
     * 后缀两处相同且唯一，一条规则覆盖两种场景（那条渐变也只在 active 下存在）。 */
    P + ' [class*="_composerSeat"]{',
    '  background:transparent!important;',
    '}',

    /* 外框透明：让整屏背景露出来。
     * ⚠️ _frame 后缀不唯一（客户端里有 11 个），不能裸用后缀；用「包含侧栏列」
     * 这个结构锚点 ⇒ [class*="_frame"]:has(…) 只会命中应用外框。
     * （:has() 宿主自己也在用，见新版布局里的
     *   .<哈希>_root:has([data-conversation-composer-overlay])。） */
    P + ' [class*="_frame"]:has([class*="_sidebarCol"]){',
    '  background:transparent!important;',
    '}',

    /* Windows 桌面壳的顶栏（标题栏拖拽条）——**直接显示背景图层，不铺任何半透明遮罩**。
     * 宿主在顶栏这条上有两层不透明来源，缺一不可：
     *   1) 外框 _frame —— 给 padding-top 预留的顶栏高度填色
     *      （宿主自己那条是 (0,2,0) 与早期外框规则打平，这里结构性地胜出）；
     *   2) 外框 :before —— 高 var(--dsh-windows-titlebar-height) 的全宽拖拽条，
     *      自己又铺了一层同色底，正是「顶栏被半透明遮罩盖住」的观感来源。
     * 两层都清成 transparent 后，顶栏整条（含中央/右侧，以及内容卡左上角 16px
     * 圆角缺口）露出的就是 html::before 那张照片，对比度由 html::after 的黑色 .55
     * 遮罩统一承担 —— 与左右栏上方、以及 Kirara 首页「顶栏就是照片」的分层语义一致。
     * ⚠️ 只清 background，**保留 :before 自身的 -webkit-app-region:drag**
     * （窗口拖拽区，宿主给的，不能动），也不动它的 height/inset。 */
    PT + ' [class*="_frame"]:has([class*="_sidebarCol"]),',
    PT + ' [class*="_frame"]:has([class*="_sidebarCol"]):before{',
    '  background:transparent!important;',
    '}',

    /* Windows 标题栏（右上角最小化/最大化/关闭那条）的底色：**全透明**。
     *
     * 这条规则**就在本页生效**：preload 建的那个隐藏探针 `span` 在本页 `document.body` 里
     *（实测 `window === window.top`、`document.querySelector` 直接能查到它）。
     * preload 把它的 `background-color` 读出来，经 `dsh-desktop:windows-appearance` 交给
     * 主进程的 `setTitleBarOverlay()` —— 这是**唯一**能影响那条标题栏的入口：
     * 标题栏由 Windows 合成器绘制，页面里没有对应的 DOM 节点，普通 CSS 碰不到它。
     *
     * ★ 为什么是「透明」而不是「采样近似色」（本次修复）：
     *   Chromium 的 Window Controls Overlay **吃带 alpha 的颜色** —— 本宿主 Electron 44 实测：
     *   `rgba(0,0,0,0)` ⇒ 三个按钮图标直接画在网页上，底下顶栏原样透出，整条带子彻底消失
     *  （复测方法与像素数据见 docs/troubleshooting.md 的「Windows 标题栏底色」）。
     *   采样近似色是更早那版「只能推不透明色」结论下的妥协：整条带子只能有**一个**颜色，
     *   而带子底下是横向有变化的照片 ⇒ 采样点附近贴合、两侧必然有色差 ——
     *   观感就是用户看到的那块「纯色背景层」。alpha 可用之后这层底色整个不需要，采样器已删除。
     *
     * ⚠️ 浅色那条写 **alpha = 1/255**（0.004）而不是 0，**这不是笔误**：
     *   ① 宿主的颜色链路会过一次 canvas（`fillStyle` + `fillRect` → `getImageData`），
     *      alpha=0 时 RGB 被抹成 0 ⇒ 实际推过去的是 `rgba(0,0,0,0)`，「浅色兜底白」留不住；
     *   ② alpha = 1/255 时 canvas 原样保留 RGB ⇒ 推过去 `rgba(255,255,255,0.0039)`，
     *      而这条带子的观感与 alpha=0 **实测完全一致**（Electron 44 窗口按钮区像素普查：
     *      本品红 6005 + 字形 78，对照 alpha=0 是 6006 + 78）⇒ 不存在肉眼可见的白膜；
     *   ③ 于是「宿主只取 RGB」的旧实现会退回**白**（浅色）/ **黑**（深色），
     *      正是「实在透明不了」时想要的兜底实色（宿主自己推的初始底色也是 #f9fafb / #1b1b1c）。
     *   深色那条不需要这层保护：黑色 RGB 被抹成 0 仍是黑。
     * ⚠️ 只改探针的**计算后颜色**，绝不覆盖 `--dsw-specific-sidebar-fill` 本身 ——
     * 覆盖 token 会把菜单与所有浮层一起变透明（见约束 1）。
     * ⚠️ 选择器写成 `span[style*="--dsw-specific-sidebar-fill"]`：探针的 style 是 preload
     * 用字符串拼出来的，实测序列化后属性值带双引号，不带引号的选择器匹配不到。
     * ⚠️ 深色主题单独一条（PD 前缀特异度更高）：两条只在「兜底 RGB」上不同，
     * 浅色那条压不过它 ⇒ 深色主题必然拿到黑。 */
    P + ' span[style*="--dsw-specific-sidebar-fill"]{',
    '  background-color:rgba(255,255,255,0.004)!important;',
    '}',
    PD + ' span[style*="--dsw-specific-sidebar-fill"]{',
    '  background-color:rgba(0,0,0,0)!important;',
    '}',

    /* ⚠️ 图层位置（此处是首版「界面全黑」事故的根因，改动前务必读完）
     * 应用内容（外框）是 position:relative + z-index:auto 的定位元素，
     * 其子列全是普通流内内容 —— 若把背景板作为 body 的定位于元素插到 #root 之后，
     * 它必然绘制在整个应用之上（连 z-index:0 也一样），会把正文和侧栏盖死。
     * 正确位置：html 自身堆叠上下文里的负 z-index 伪元素 —— 按 CSS 2.1 附录 E，
     * 顺序是「根背景 → 负 z 层 → 流内内容」，它天然落在所有 UI 之下；
     * 同为 -1 的 ::before / ::after 按树序叠放（遮罩在后，压住照片）。
     * **因此不需要任何 DOM 节点**：照片走 html 上的自定义属性，由 ::before 消费。
     * ⚠️ 但 body 的背景属于「流内内容」这一步，会盖住负 z 层 ——
     * `body{background-color:transparent}` 是这条链路唯一承重的规则，不能删。
     * （html 背景本就在伪元素之下，无需处理；不插节点也就不需要 isolation 兜底。） */
    P + ' body{',
    '  background-color:transparent!important;',
    '}',

    /* 背景层：底色 + 服务器照片（没有照片时回落到渐变） */
    P + '::before{',
    '  content:"";',
    '  position:fixed;',
    '  inset:0;',
    '  z-index:-1;',
    '  pointer-events:none;',
    '  background-color:#0d1017;',
    '  background-image:var(' + PHOTO_VAR + ',' + FALLBACK_PHOTO + ');',
    '  background-position:center;',
    '  background-size:cover;',
    '  background-repeat:no-repeat;',
    '}',

    /* 半透明黑遮罩（恒定黑色，语义同 Kirara 的 HomeOverlay）
     * 同为 z-index:-1 → 与背景层同层，靠树序压在 ::before 之上 */
    P + '::after{',
    '  content:"";',
    '  position:fixed;',
    '  inset:0;',
    '  z-index:-1;',
    '  pointer-events:none;',
    '  background:rgba(0,0,0,.55);',
    '}',

    /* 无障碍：系统要求降低透明度时全部退回不透明
     * 放最后 + 深色变体一并列出 —— 只写浅色前缀压不过上面的深色规则（特异度更高）。
     * 承担「露出照片」的每一层都要在这里换回实色：三个列 / **顶栏（外框 + 拖拽条）** /
     * 标题栏（探针）/ 输入区底座。内层（侧栏面板根 / 会话根）**始终**透明 —— 退回不透明
     * 只需要把承担颜色的那一层换成实色，内层若也实色反而会把上面约束 8 的语义搞乱。 */
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
  ].join("\n");

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  /** 读宿主注入的启动全局量（首帧就绪；缺失/损坏时返回 null）。 */
  function readBootGlobal() {
    try {
      var value = window[GLOBAL_KEY];
      if (value && typeof value === "object") return value;
    } catch (err) {
      /* 忽略：跨域/沙箱读 window 属性异常时按缺失处理 */
    }
    return null;
  }

  /** 规范化 routePath：去掉末尾斜杠，保证为空时回落到默认值。 */
  function normalizeRoutePath(input) {
    var raw = typeof input === "string" ? input.trim() : "";
    if (raw.length === 0) return DEFAULT_ROUTE_PATH;
    if (raw.charAt(0) !== "/") raw = "/" + raw;
    while (raw.length > 1 && raw.charAt(raw.length - 1) === "/") {
      raw = raw.slice(0, -1);
    }
    return raw;
  }

  /** 注入样式表（幂等：已存在则直接复用）。 */
  function ensureStyle() {
    var existing = document.querySelector(
      "style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]"
    );
    if (existing) return existing;

    var tag = document.createElement("style");
    tag.dataset.plugin = PLUGIN_NAME;
    tag.dataset.pluginCss = CSS_ID;
    tag.textContent = OVERRIDE_CSS;
    document.head.appendChild(tag);
    return tag;
  }

  /** 打上外观标记：CSS 全部选择器都以此为前提。 */
  function markAppearanceActive() {
    document.documentElement.setAttribute(HTML_ATTR, "kirara");
  }

  /**
   * 摘掉宿主写在索引页里的首屏样式表（带 BOOT_MARKER 的那些）。
   *
   * ⚠️ 这一步和「移除自己的 <style>」不是一回事，两件都要做：
   *   宿主半边的首屏 <style> 是**渲染索引页时**注入的静态文本，运行时关插件
   *   不会让它消失；自己的 <style> 由 dsh-client-modules 随模块一起回收。
   * 只在 document.head 里找（首屏样式只注入 head），按标记匹配，不会误伤别的样式表。
   */
  function removeBootStyles() {
    if (!document.head || typeof document.head.querySelectorAll !== "function") return;
    var tags = document.head.querySelectorAll("style");
    for (var i = 0; i < tags.length; i += 1) {
      var text = tags[i].textContent || "";
      if (text.indexOf(BOOT_MARKER) === -1) continue;
      if (tags[i].parentNode) tags[i].parentNode.removeChild(tags[i]);
    }
  }

  /* ------------------------------------------------------------------ *
   * 照片层（只写一个 CSS 自定义属性，不插任何 DOM 节点）
   * ------------------------------------------------------------------ */

  /**
   * 创建照片层控制器。
   *
   * ★ 不创建任何元素：照片写在 `<html>` 的自定义属性 `--kirara-theme-photo` 上，
   * 由 OVERRIDE_CSS 的 `:root::before { background-image: var(--kirara-theme-photo, …) }`
   * 消费。首版用一个 `position:fixed` 的 div 承载照片并插在 `#root` 之后
   * → 它成为 body 的定位子节点、绘制在整个应用之上 → 界面全黑（见 OVERRIDE_CSS
   * 的图层约束注释）。改成自定义属性后，背景层永远只有那对负 z 序伪元素。
   *
   * 写自定义属性而不是写元素 style 的额外好处：内联样式天然覆盖宿主注入的
   * `<style>` 里的同名声明（宿主在首帧就把照片地址写进 `:root`），因此
   * 「宿主首帧 → 客户端换图」全程不需要改动 DOM 结构。
   *
   * @returns {{showFallback:Function, swap:Function, dispose:Function}}
   */
  function createPhotoLayer() {
    var element = document.documentElement;
    var disposed = false;
    var currentUrl = "";
    var pending = null;

    /** 回落到渐变兜底：必须显式写回渐变值（只删属性会退回宿主注入的 url(...)，即旧图）。 */
    function showFallback() {
      if (disposed) return;
      currentUrl = "";
      if (pending) {
        pending.onload = null;
        pending.onerror = null;
        pending = null;
      }
      element.style.setProperty(PHOTO_VAR, FALLBACK_PHOTO);
    }

    /**
     * 换成新图：先离屏解码，解码成功才写属性；失败则保留当前图
     * （对齐 BackgroundService 的降级策略）。
     */
    function swap(url) {
      if (disposed || typeof url !== "string" || url.length === 0) return;
      if (url === currentUrl) return;
      if (pending && pending.src === url) return;
      if (pending) {
        pending.onload = null;
        pending.onerror = null;
        pending = null;
      }

      var image = new Image();
      pending = image;
      image.decoding = "async";

      image.onload = function () {
        if (pending === image) pending = null;
        if (disposed) return;
        currentUrl = url;
        element.style.setProperty(PHOTO_VAR, 'url("' + url.replace(/"/g, '\\"') + '")');
      };
      image.onerror = function () {
        if (pending === image) pending = null;
        /* 解码失败：沿用当前图 */
      };
      image.src = url;
    }

    function dispose() {
      disposed = true;
      currentUrl = "";
      if (pending) {
        pending.onload = null;
        pending.onerror = null;
        pending = null;
      }
      element.style.removeProperty(PHOTO_VAR);
    }

    return {
      showFallback: showFallback,
      swap: swap,
      dispose: dispose
    };
  }

  /* ------------------------------------------------------------------ *
   * 版本轮询
   * ------------------------------------------------------------------ */

  /**
   * 建立轮询器。
   *
   * 三种节奏：
   *   - **常态**：前 60s 每 10s 一次，之后每 180s 一次（与服务端 30 分钟节流对齐）；
   *   - **暖机**：挂载后的前 30s 里只要还没拿到图，就每 1.5s 试一次 ——
   *     插件可能在页面渲染之后才被启用（那时没有 boot 全局量），
   *     或者宿主刚挂载、还在读盘 / 首次同步，图要过一会儿才出现；
   *   - **立刻一轮**：`refresh()`，挂载时与「回到前台」时用，不等下一个定时点。
   *
   * ⚠️ 旧的 `poke()` 只是「把定时器重置成一个完整间隔」，并不真的跑一轮 ——
   * 名字叫「立刻补一次」，实际把下一次推迟得更远。已换成真的 `refresh()`。
   */
  function createPoller(routePath, onStateChanged) {
    var startedAt = Date.now();
    var timer = null;
    var stopped = false;
    var inFlight = false;
    var lastVersion = null;
    /** 最近一次成功读到的状态里是否有图：暖机期「还没图就快试」的依据。 */
    var lastHadImage = false;

    function interval() {
      return Date.now() - startedAt < FIRST_POLL_WINDOW_MS
        ? FAST_POLL_MS
        : SLOW_POLL_MS;
    }

    /** 暖机期的短间隔；不在暖机期返回 null（表示按常态间隔）。 */
    function warmupInterval() {
      if (lastHadImage) return null;
      if (Date.now() - startedAt >= WARMUP_MS) return null;
      return WARMUP_RETRY_MS;
    }

    function schedule(delay) {
      if (stopped) return;
      var wait = typeof delay === "number" ? delay : interval();
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, wait);
      if (timer && typeof timer.unref === "function") timer.unref();
    }

    function tick() {
      timer = null;
      if (stopped) return;
      if (document.hidden || inFlight) {
        schedule();
        return;
      }

      inFlight = true;
      var url =
        routePath + "/state.json?_=" + encodeURIComponent(String(Date.now()));

      fetch(url, { cache: "no-store", credentials: "same-origin" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (state) {
          if (stopped || !state || typeof state !== "object") return;
          var version = typeof state.version === "string" ? state.version : "";
          lastHadImage = state.hasImage === true && state.isDefault !== true;
          var changed = version !== lastVersion;
          lastVersion = version;
          if (!changed) return;
          onStateChanged({
            version: version,
            hasImage: state.hasImage === true,
            isDefault: state.isDefault === true,
            /* 宿主算好的**带版本**同源地址，直接用 ⇒ 与首屏写入的 URL 逐字节相同，
             * 不会因为「同图不同 URL」而白白重解码一次 4MB 的图。 */
            imageUrl: typeof state.imageUrl === "string" ? state.imageUrl : "",
            backdrop: typeof state.backdrop === "string" ? state.backdrop : ""
          });
        })
        .catch(function () {
          /* 网络/解析失败：静默跳过本轮，下一轮继续（不打断现有外观） */
        })
        .then(function () {
          inFlight = false;
          var warm = warmupInterval();
          schedule(warm === null ? undefined : warm);
        });
    }

    function start() {
      schedule();
    }

    function stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    /** 缓存首帧状态，避免刚启动就与注入的 boot 全局量重复换图。 */
    function seed(version) {
      lastVersion = typeof version === "string" ? version : null;
    }

    /** 立刻跑一轮（不等下一个定时点）：挂载时、回到前台时用。 */
    function refresh() {
      if (stopped) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      tick();
    }

    return { start: start, stop: stop, seed: seed, refresh: refresh };
  }

  /* ------------------------------------------------------------------ *
   * 插件主体
   * ------------------------------------------------------------------ */

  function buildPlugin() {
    return {
      name: PLUGIN_NAME,
      apply: function (ctx) {
        var boot = readBootGlobal() || {};
        var routePath = normalizeRoutePath(boot.routePath);

        ensureStyle();
        markAppearanceActive();

        /* Windows 标题栏（右上角窗口按钮那条）：底色**全部**由 OVERRIDE_CSS 里那条探针规则
         * 决定（置成全透明），客户端不再需要参与 —— 早前「采样近似色写进 <html>」那套机制
         * 已删除，理由见那条规则上方的注释。 */

        /* ★ 照片层不创建任何 DOM 节点：只往 <html> 写一个自定义属性，
         * 由 CSS 里的 :root::before 消费（见 OVERRIDE_CSS 的图层约束注释）。
         * 首版这里 appendChild 了一个 position:fixed 的 div → 画在整个应用之上
         * → 界面全黑（第一次事故）。 */
        var photoLayer = createPhotoLayer();

        /* 首帧：宿主已经给了我们 URL / 是否有图，直接铺上，不等轮询 */
        var bootVersion = typeof boot.version === "string" ? boot.version : "";
        /** 换图入口（照片层只认 URL；标题栏不再参与，它由 CSS 全权负责）。 */
        function applyImage(url) {
          if (typeof url === "string" && url.length > 0) {
            photoLayer.swap(url);
          } else {
            photoLayer.showFallback();
          }
        }

        applyImage(typeof boot.imageUrl === "string" ? boot.imageUrl : "");

        var cleanup = [];
        var timers = [];

        /* 轮询器：版本变化才去换图（对齐服务端 30 分钟节流） */
        var lastImageVersion = bootVersion;
        var poller = createPoller(routePath, function (state) {
          if (!state.hasImage || state.isDefault) {
            applyImage("");
            return;
          }
          if (state.version === lastImageVersion) return;
          lastImageVersion = state.version;
          /* 优先用宿主 state.json 里算好的**带版本同源地址** —— 它与首屏写入的 URL
           * 逐字节相同，两边一致时 swap() 会直接短路，不会白白重解码一次整图。 */
          applyImage(
            state.imageUrl ||
              routePath +
                "/background?v=" +
                encodeURIComponent(state.version || String(Date.now()))
          );
        });
        poller.seed(bootVersion);
        poller.start();
        /* ★ 立刻探一轮，不等第一个定时点（原本要干等 10s）。
         * 插件可能是**页面渲染之后**才被启用的 —— 这时没有 boot 全局量，
         * 拿不到 imageUrl，只有这一轮能立刻把宿主已经缓存好的背景图铺上去。
         * 成本是一次本机同源请求；宿主那边没图时会走暖机快重试（见 createPoller）。 */
        poller.refresh();
        cleanup.push(function () {
          poller.stop();
        });

        /* 可见性恢复时补一次轮询（背景用 cover 自适应，无需重算尺寸） */
        var visibilityHandler = function () {
          if (document.hidden) return;
          poller.refresh();
        };
        document.addEventListener("visibilitychange", visibilityHandler);
        cleanup.push(function () {
          document.removeEventListener("visibilitychange", visibilityHandler);
        });

        /* 主题切换无需重算：所有配色都是 CSS 里靠 body 属性驱动的 */

        /* 卸载：逆序清理 + 移除样式表 + 摘掉标记属性（无内联属性残留） */
        ctx.effect(function () {
          return function () {
            for (var i = cleanup.length - 1; i >= 0; i -= 1) {
              try {
                cleanup[i]();
              } catch (err) {
                /* 单项失败不阻断整体回收 */
              }
            }
            for (var j = timers.length - 1; j >= 0; j -= 1) {
              clearTimeout(timers[j]);
            }
            photoLayer.dispose();
            document.documentElement.removeAttribute(HTML_ATTR);
            /* ★ 宿主写在索引页里的首屏样式不会随插件卸载消失（它是渲染索引页时
             *   注入的静态文本），必须自己按标记摘掉 —— 否则关掉插件后背景、遮罩、
             *   半透明列全都还在，只有刷新页面才会还原。 */
            removeBootStyles();
            var tag = document.querySelector(
              "style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]"
            );
            if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
          };
        }, "kirara-theme-appearance");
      }
    };
  }

  window.__ModuleLoader__.load({
    id: PLUGIN_NAME,
    factory: function (require) {
      var module = { exports: {} };
      module.exports = buildPlugin();
      return module.exports;
    }
  });
})();
