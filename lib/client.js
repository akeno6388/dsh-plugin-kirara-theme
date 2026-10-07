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
 *   应用内容 `.BynINW_frame` 是 `position:relative` + `z-index:auto` 的定位元素，
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
  // 服务器照片走自定义属性（不是 DOM 节点），由 `:root[...]::before` 消费。
  var PHOTO_VAR = "--kirara-theme-photo";
  // 与宿主 `lib/index.js` 的 DEFAULT_BACKDROP_CSS **必须逐字节一致**（README §4.2）。
  var FALLBACK_PHOTO =
    "linear-gradient(135deg,#1b2030 0%,#0d1017 60%,#080a10 100%)";

  var DEFAULT_ROUTE_PATH = "/kirara-theme";
  var FIRST_POLL_WINDOW_MS = 60000;
  var FAST_POLL_MS = 10000;
  var SLOW_POLL_MS = 180000;

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
   *  7. 侧栏容器类名（`.BynINW_sidebarCol` / `._2H3hWW_root`）与会话主界面
   *     根类名（`.Dc7zOa_root` / `.Dc7zOa_composerSeat`）是构建期哈希，构建
   *     变化会失效 —— 但它们没有稳定属性可依赖，只能如此。
   *     失效后果是「该处不再半透明 / 圆角消失」，不会破坏布局，可接受。
   *  8. **磨砂只能由「列」承担**：宿主在侧栏内容根 `._2H3hWW_root` 与
   *     会话主界面根 `.Dc7zOa_root` 上各自铺了不透明底。插件若只改列的颜色，
   *     内层实色会把照片彻底挡住（＝「主界面看不到背景」的根因）；两层同色
   *     半透明叠加则会反向推回近乎实心（0.72 叠 0.72 ≈ 0.92）。
   *     因此内层的实色底必须显式清成 transparent，透明度只在列上设定一次。
   *  9. **Windows 顶栏是「零透明度」的唯一例外**：顶栏那条不设任何透明度，
   *     直接 transparent 露出背景图层。宿主在顶栏上有**两层**不透明来源，
   *     少清一层就剩一层：`.BynINW_frame`（`padding-top` 预留的顶栏高度，
   *     填的是 `--dsw-specific-sidebar-fill`）与 `.BynINW_frame:before`
   *     （`height:var(--dsh-windows-titlebar-height)` 的全宽拖拽条，自己又铺了一层
   *     同色底 —— 这就是「顶栏被半透明遮罩盖住」的观感来源）。两者的症状都是
   *     「顶栏比下方内容区更亮」。
   *     ⚠️ 只清 `background`，**保留 `:before` 的 `-webkit-app-region:drag`**
   *     （窗口拖拽几何是宿主给的，改了窗口就拖不动）。
   *     ⚠️ 清外框那条的完整前缀是 `:root[data-windows-titlebar][data-kirara-theme]`，
   *     特异度 (0,3,0)，**高于**宿主自身的 `[data-windows-titlebar] .BynINW_frame` (0,2,0)；
   *     所以这里把 `.BynINW_frame` 与 `:before` 写进**同一条规则**显式声明，
   *     不依赖「作者样式表内后者胜」这种顺序（不写也能靠早前那条通用外框规则兜底，
   *     但那一条与宿主是打平的）。
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
    /* 侧栏列：半透明底
     * 磨砂只由列承担（约束 8）—— `._2H3hWW_root` 的实色底必须清掉，
     * 否则两层同色半透明叠加会把侧栏推回 ≈0.92 实心。 */
    P + " .BynINW_sidebarCol{",
    "  background:" + SIDEBAR_FILL_LIGHT + sidebarFillAlpha() + ")!important;",
    "}",
    PD + " .BynINW_sidebarCol{",
    "  background:" + SIDEBAR_FILL_DARK + sidebarFillAlpha() + ")!important;",
    "}",
    P + " ._2H3hWW_root{",
    "  background:transparent!important;",
    "}",

    /* 会话列表底部的渐隐遮罩（`._9lTDKa_fade`，24px，absolute bottom:0，铺的是
     * `linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill))`）
     * —— 它就是「左侧栏底部、账户区上方」那条渐变容器。
     * 语义上它属于「不透明侧栏」时代：列表滚到底时用一截实色把文字压掉。
     * 侧栏已经是半透明照片，这截实色终点与整块面板不再一致 ⇒ 去成 transparent。
     * ⚠️ 不要改它的 height / position：它只是视觉遮罩（`pointer-events:none`），
     * 清掉底色后列表滚动与命中区完全不变。
     * （宿主自己也认为它不适合透明场景：darwin 下直接 `display:none`。） */
    P + " ._9lTDKa_fade{",
    "  background:transparent!important;",
    "}",

    /* 侧栏右上角圆角（仅 Windows 标题栏壳）—— 与内容卡左上角 16px 圆角对称，
     * 半径直接取宿主自身的 `--dsh-windows-content-radius`（跟随官方值，不写死）。
     * 圆角缺口露出的是「外框背景」，而外框已被置为 transparent ⇒ 缺口处看到整屏照片。
     * 深色无需单独覆盖：本条只写 border-radius，不与深色的 background 规则冲突。 */
    PT + " .BynINW_sidebarCol{",
    "  border-radius:0 var(--dsh-windows-content-radius,16px) 0 0;",
    "}",

    /* 内容列 + 右侧栏：半透明底（.86）—— 照片能透出来，正文对比度仍够用
     * （浅色 0.86×252 + 0.14×暗 ≈ 219；深色 ≈ 20；黑遮罩再兜一层对比度）
     * 右侧栏在 Windows 下宿主**没有**给背景（原生就显得与内容列一体），
     * 外框透明后它会直接露出照片、正文失去衬底 —— 这里补上同款磨砂。 */
    P + " .BynINW_centerCol,",
    P + " .BynINW_rightbarCol{",
    "  background:rgba(252,252,253,.86)!important;",
    "}",
    PD + " .BynINW_centerCol,",
    PD + " .BynINW_rightbarCol{",
    "  background:rgba(16,18,24,.86)!important;",
    "}",

    /* 会话主界面根：宿主在此铺了**不透明**的 `--dsw-alias-bg-base`，
     * 正好整块盖住内容列 —— 不清掉它就永远只能看到纯色主界面（本次「主界面
     * 看不到背景」的根因）。清成 transparent 后由内容列统一提供磨砂。 */
    P + " .Dc7zOa_root{",
    "  background:transparent!important;",
    "}",

    /* 会话输入区底座：宿主用一条渐变把底部收口到**不透明** bg-base
     * （sticky 遮住滚上来的正文）。本插件要去掉这条渐变：底座整块 transparent，
     * 主界面从顶到底与整屏照片同透明度，不再出现「下方越往下越实」的渐隐带。
     * ⚠️ 同时覆盖 `[data-content-phase=active]`（内嵌会话 body 用的是另一个属性名，
     * 宿主为它写了一份同款渐变；只压 root 那份会留下内嵌会话的渐隐带）。
     * 代价：滚到输入框下方的正文不再被 36px 实色带遮住，会一直透到照片上。 */
    P + " .Dc7zOa_root[data-phase=active] .Dc7zOa_composerSeat,",
    P + " .Dc7zOa_embeddedBody[data-content-phase=active] .Dc7zOa_composerSeat{",
    "  background:transparent!important;",
    "}",

    /* 外框透明：让整屏背景露出来 */
    P + " .BynINW_frame{",
    "  background:transparent!important;",
    "}",

    /* Windows 桌面壳的顶栏（标题栏拖拽条）——**直接显示背景图层，不铺任何半透明遮罩**。
     * 宿主在顶栏这条上有两层不透明来源，缺一不可：
     *   1) `.BynINW_frame{background:var(--dsw-specific-sidebar-fill)}` —— 给 `padding-top`
     *      预留的顶栏高度填色。本插件早前已有一条外框 transparent 规则，但那是 (0,2,0)
     *      与它**打平**、只靠「作者样式表内后者胜」才赢；这里把它并进同一条规则：
     *      前缀多一个 `[data-windows-titlebar]` ⇒ (0,3,0) **结构性胜出**，不再依赖顺序；
     *   2) `.BynINW_frame:before` —— `height:var(--dsh-windows-titlebar-height)` 的全宽拖拽条，
     *      自己铺了一层 `--dsw-specific-sidebar-fill`，正是「顶栏被半透明遮罩盖住」的观感来源。
     * 两层都清成 transparent 后，顶栏整条（含中央/右侧，以及内容卡左上角 16px 圆角缺口）
     * 露出的就是 `html::before` 那张照片，对比度由 `html::after` 的黑色 .55 遮罩统一承担 ——
     * 与左右栏上方、以及 Kirara 首页「顶栏就是照片」的分层语义一致。
     * ⚠️ 只清 background，**保留 `:before` 自身的 `-webkit-app-region:drag`**（窗口拖拽区，
     * 宿主给的，不能动），也不动它的 height/inset。 */
    PT + " .BynINW_frame,",
    PT + " .BynINW_frame:before{",
    "  background:transparent!important;",
    "}",

    /* Windows 标题栏（右上角最小化/最大化/关闭那条）的底色。
     *
     * 这条规则**就在本页生效**：preload 建的那个隐藏探针 `span` 在本页 `document.body` 里
     *（实测 `window === window.top`、`document.querySelector` 直接能查到它）。
     * preload 把它的 `background-color` 读出来，经 `dsh-desktop:windows-appearance` 交给
     * 主进程的 `setTitleBarOverlay()` —— 这是**唯一**能影响那条标题栏的入口：
     * 标题栏由 Windows 合成器绘制，页面里没有对应的 DOM 节点，普通 CSS 碰不到它。
     * 探针原本解析成 `--dsw-specific-sidebar-fill`（不透明侧栏底色），铺在整屏照片上
     * 就是右上角那块突兀的实色。
     *
     * ⚠️ 只改探针的**计算后颜色**，绝不覆盖 `--dsw-specific-sidebar-fill` 本身 ——
     * 覆盖 token 会把菜单与所有浮层一起变透明（见约束 1）。
     * ⚠️ 选择器写成 `span[style*="--dsw-specific-sidebar-fill"]`：探针的 style 是 preload
     * 用字符串拼出来的，实测序列化后属性值带双引号，不带引号的选择器匹配不到。
     * ⚠️ 变量 `--kirara-caption-fill` 由 `createCaptionSampler()` 采样背景图后写在
     * `<html>` 的行内样式上；它的值就是「`html::after` 遮罩压在照片上」的合成色，也就是
     * 顶栏在该处的观感 ⇒ 标题栏与顶栏同色。采样未就绪时用遮罩色兜底。 */
    P + " span[style*=\"--dsw-specific-sidebar-fill\"]{",
    "  background-color:var(--kirara-caption-fill,rgba(0,0,0,.55))!important;",
    "}",

    /* ⚠️ 图层位置（此处是首版「界面全黑」事故的根因，改动前务必读完）
     * 应用内容（.BynINW_frame）是 position:relative + z-index:auto 的定位元素，
     * 其子列全是普通流内内容 —— 若把背景板作为 body 的定位于元素插到 #root 之后，
     * 它必然绘制在整个应用之上（连 z-index:0 也一样），会把正文和侧栏盖死。
     * 正确位置：html 自身堆叠上下文里的负 z-index 伪元素 —— 按 CSS 2.1 附录 E，
     * 顺序是「根背景 → 负 z 层 → 流内内容」，它天然落在所有 UI 之下；
     * 同为 -1 的 ::before / ::after 按树序叠放（遮罩在后，压住照片）。
     * **因此不需要任何 DOM 节点**：照片走 html 上的自定义属性，由 ::before 消费。
     * ⚠️ 但 body 的背景属于「流内内容」这一步，会盖住负 z 层 ——
     * `body{background-color:transparent}` 是这条链路唯一承重的规则，不能删。
     * （html 背景本就在伪元素之下，无需处理；不插节点也就不需要 isolation 兜底。） */
    P + " body{",
    "  background-color:transparent!important;",
    "}",

    /* 背景层：底色 + 服务器照片（没有照片时回落到渐变） */
    P + "::before{",
    "  content:\"\";",
    "  position:fixed;",
    "  inset:0;",
    "  z-index:-1;",
    "  pointer-events:none;",
    "  background-color:#0d1017;",
    "  background-image:var(" + PHOTO_VAR + "," + FALLBACK_PHOTO + ");",
    "  background-position:center;",
    "  background-size:cover;",
    "  background-repeat:no-repeat;",
    "}",

    /* 半透明黑遮罩（恒定黑色，语义同 Kirara 的 HomeOverlay）
     * 同为 z-index:-1 → 与背景层同层，靠树序压在 ::before 之上 */
    P + "::after{",
    "  content:\"\";",
    "  position:fixed;",
    "  inset:0;",
    "  z-index:-1;",
    "  pointer-events:none;",
    "  background:rgba(0,0,0,.55);",
    "}",

    /* 无障碍：系统要求降低透明度时全部退回不透明
     * 放最后 + 深色变体一并列出 —— 只写浅色前缀压不过上面的深色规则（特异度更高）。
     * 承担「露出照片」的每一层都要在这里换回实色：三个列 / **顶栏（外框 + 拖拽条）** /
     * 输入区底座。内层（`._2H3hWW_root` / `.Dc7zOa_root`）**始终**透明 —— 退回不透明
     * 只需要把承担颜色的那一层换成实色，内层若也实色反而会把上面约束 8 的语义搞乱。 */
    "@media (prefers-reduced-transparency:reduce){",
    "  " + P + " .BynINW_sidebarCol,",
    "  " + PT + " .BynINW_frame,",
    "  " + PT + " .BynINW_frame:before,",
    "  " + P + " span[style*=\"--dsw-specific-sidebar-fill\"]{",
    "    background:var(--dsw-specific-sidebar-fill)!important;",
    "  }",
    "  " + P + " .BynINW_centerCol,",
    "  " + P + " .BynINW_rightbarCol{",
    "    background:var(--dsw-alias-bg-base)!important;",
    "  }",
    "  " + PD + " .BynINW_sidebarCol,",
    "  " + PTD + " .BynINW_frame,",
    "  " + PTD + " .BynINW_frame:before{",
    "    background:var(--dsw-specific-sidebar-fill)!important;",
    "  }",
    "  " + PD + " .BynINW_centerCol,",
    "  " + PD + " .BynINW_rightbarCol{",
    "    background:var(--dsw-alias-bg-base)!important;",
    "  }",
    "}"
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

  /* ------------------------------------------------------------------ *
   * Windows 标题栏底色 —— 写进**顶层窗口**的独立样式表
   * ------------------------------------------------------------------ */

  /**
   * 标题栏近似色所在的 CSS 自定义属性（写在**本页** `<html>` 的行内样式上，
   * 由 OVERRIDE_CSS 里那条探针规则消费）。
   */
  var CAPTION_FILL_VAR = "--kirara-caption-fill";
  /** 标题栏采样点：距右边缘的像素数（≈ Windows 三按钮簇的中心）。 */
  var CAPTION_SAMPLE_INSET_X = 60;
  /** 标题栏采样点的纵向位置（标题栏高 40px，取靠上一点避开任何边缘压边）。 */
  var CAPTION_SAMPLE_Y = 4;
  /** 采样小块的尺寸（屏幕像素）：覆盖按钮簇附近一小片，取平均色而不是单像素。 */
  var CAPTION_PATCH_WIDTH = 160;
  var CAPTION_PATCH_HEIGHT = 28;

  /**
   * 把标题栏近似色写进本页 `<html>`（空值 = 摘掉，回到规则里的遮罩色兜底）。
   *
   * ⚠️ 历史教训：这里曾走「注入到 `window.top.document.head` 的独立样式表」那条路，
   *    前提是「GUI 跑在 iframe 里、preload 的探针只在顶层文档」。那个前提是**错的** ——
   *    实测 `window === window.top`，探针就在本页。于是 `window.top === window` 的守卫
   *    直接 return，整条链路静默失效（症状：右上角永远不变）。
   *    **不要再引入跨文档注入**：探针在哪，规则就在哪（即本页）。
   */
  function setCaptionFill(value) {
    var root = document.documentElement;
    try {
      if (typeof value === "string" && value.length > 0) {
        root.style.setProperty(CAPTION_FILL_VAR, value);
      } else {
        root.style.removeProperty(CAPTION_FILL_VAR);
      }
    } catch (err) {
      /* 忽略：不影响本页观感 */
    }
  }

  /* ------------------------------------------------------------------ *
   * 标题栏近似色采样
   * ------------------------------------------------------------------ */

  /** 解析 `rgba(r,g,b,a)` / `rgb(r,g,b)`；失败返回 null。 */
  function parseScrim(value) {
    var match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
      typeof value === "string" ? value.trim() : ""
    );
    if (!match) return null;
    var alpha = match[4] === undefined ? 1 : Number(match[4]);
    if (!isFinite(alpha)) alpha = 1;
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: Math.min(1, Math.max(0, alpha)) };
  }

  /** 把数值夹到 0..255 的整数（颜色通道用）。 */
  function clampChannel(value) {
    return Math.min(255, Math.max(0, Math.round(value)));
  }

  /**
   * 把「照片在某点的像素色」换算成**该给标题栏的实色**（纯函数，便于离线验证）。
   *
   * ★ 分层事实（决定了公式，改前务必读完）：
   *   标题栏是**操作系统画在网页之上**的一层（Electron `titleBarOverlay` / DWM），
   *   **没有任何东西会再压在它上面**。它底下露出来的那条顶栏是「照片 + `html::after` 遮罩」。
   *   所以要让两者观感一致，就该把「顶栏在该点的最终观感」原样交给标题栏：
   *
   *     X = (1-a)·photo + a·scrim        ← 与 `html::after` 同款合成，只做一次
   *
   * ⚠️ 曾经把它写成「反解」`(photo - a·scrim)/(1-a)`（即 X = photo），理由是「浏览器会把遮罩
   *    再压到标题栏上」——**那个前提是错的**：标题栏在网页之上，遮罩压不到它。
   *    后果是标题栏被**暗化了两次**（实测观感比顶栏更暗），也就是「右上角还是一条更深的实色带」。
   *
   * @param {{r:number,g:number,b:number}} photo - 照片像素。
   * @param {{r:number,g:number,b:number,a:number}|null} scrim - 遮罩色；null/全透明时原样返回。
   * @returns {{r:number,g:number,b:number}} 0..255 的整数值。
   */
  function captionColorFor(photo, scrim) {
    var alpha = scrim ? scrim.a : 0;
    var out = { r: photo.r, g: photo.g, b: photo.b };
    if (scrim && alpha > 0) {
      out = {
        r: (1 - alpha) * photo.r + alpha * scrim.r,
        g: (1 - alpha) * photo.g + alpha * scrim.g,
        b: (1 - alpha) * photo.b + alpha * scrim.b
      };
    }
    return { r: clampChannel(out.r), g: clampChannel(out.g), b: clampChannel(out.b) };
  }

  /**
   * 创建标题栏采样器：算出「顶栏在该处呈现的**不透明**颜色」。
   *
   * 背景是 `background-size:cover` + `center`，要还原某个屏幕点对应的图片像素，
   * 就得重做一次 cover 的缩放与居中裁剪 —— 所以下面按「图片按比例缩放到铺满
   * 视口、再居中裁剪」重算源坐标，而不是直接按比例取像素。
   *
   * ⚠️ 图片经同源路由 `/kirara-theme/background.jpg` 提供，因此可以 `crossOrigin`
   *    取像素；若因任何原因被污染（跨域 / 解码失败 / canvas 不可用），**静默放弃**，
   *    此时标题栏回落到 OVERRIDE_CSS 那条规则里的半透明黑 —— 不报错、不留半个状态。
   *
   * @param {Function} setFill - 写近似色的回调（`setCaptionFill`；传空串即摘掉）。
   * @param {string} scrimCss - 遮罩色的 CSS 文本（来自宿主 boot 全局量的 `scrim`）。
   * @returns {{update:Function, dispose:Function}}
   */
  function createCaptionSampler(setFill, scrimCss) {
    var scrim = parseScrim(scrimCss);
    var disposed = false;
    var pending = null;
    var activeImage = null;

    function clearPending() {
      if (!pending) return;
      pending.onload = null;
      pending.onerror = null;
      pending = null;
    }

    /** 采一次；url 为空 / 失败则摘掉近似色（回到半透明黑回落）。 */
    function update(url) {
      if (disposed || typeof setFill !== "function") return;
      if (typeof url !== "string" || url.length === 0) {
        setFill("");
        return;
      }
      if (activeImage && activeImage.src === url) return;

      clearPending();
      var image = new Image();
      pending = image;
      image.decoding = "async";
      try {
        image.crossOrigin = "anonymous";
      } catch (err) {
        /* 老浏览器忽略即可 */
      }

      image.onload = function () {
        if (pending === image) pending = null;
        if (disposed) return;
        activeImage = image;

        var fill = null;
        try {
          var naturalWidth = image.naturalWidth || image.width;
          var naturalHeight = image.naturalHeight || image.height;
          var viewportWidth = Math.max(1, window.innerWidth);
          var viewportHeight = Math.max(1, window.innerHeight);

          if (naturalWidth > 0 && naturalHeight > 0 && typeof document.createElement === "function") {
            var scale = Math.max(viewportWidth / naturalWidth, viewportHeight / naturalHeight);
            var drawnWidth = naturalWidth * scale;
            var drawnHeight = naturalHeight * scale;
            var offsetLeft = (viewportWidth - drawnWidth) / 2;
            var offsetTop = (viewportHeight - drawnHeight) / 2;

            var sampleX = Math.min(viewportWidth - 1, Math.max(0, viewportWidth - CAPTION_SAMPLE_INSET_X));
            var sampleY = Math.min(viewportHeight - 1, Math.max(0, CAPTION_SAMPLE_Y));

            var sourceX = Math.floor((sampleX - offsetLeft) / scale);
            var sourceY = Math.floor((sampleY - offsetTop) / scale);
            sourceX = Math.min(naturalWidth - 1, Math.max(0, sourceX));
            sourceY = Math.min(naturalHeight - 1, Math.max(0, sourceY));

            var canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            var context = canvas.getContext("2d", { willReadFrequently: true });
            if (context) {
              /* 取「按钮簇」那一小块的平均色，而不是单像素 —— 标题栏只有一个颜色，
               * 单点取样会让整条带子偏成那一个像素的色调（看上去就是「一块填充」）；
               * 取小块平均则代表该区域的主色调，接缝最不明显。 */
              var patchWidth = Math.max(1, Math.round(CAPTION_PATCH_WIDTH / scale));
              var patchHeight = Math.max(1, Math.round(CAPTION_PATCH_HEIGHT / scale));
              var patchX = Math.min(Math.max(0, naturalWidth - patchWidth), Math.max(0, sourceX - Math.floor(patchWidth / 2)));
              var patchY = Math.min(Math.max(0, naturalHeight - patchHeight), Math.max(0, sourceY - Math.floor(patchHeight / 2)));

              var patchCanvas = document.createElement("canvas");
              patchCanvas.width = patchWidth;
              patchCanvas.height = patchHeight;
              var patchContext = patchCanvas.getContext("2d", { willReadFrequently: true });
              if (patchContext) {
                patchContext.drawImage(
                  image,
                  patchX,
                  patchY,
                  patchWidth,
                  patchHeight,
                  0,
                  0,
                  patchWidth,
                  patchHeight
                );
                var data = patchContext.getImageData(0, 0, patchWidth, patchHeight).data;
                var sumR = 0;
                var sumG = 0;
                var sumB = 0;
                var count = 0;
                for (var p = 0; p + 3 < data.length; p += 4) {
                  sumR += data[p];
                  sumG += data[p + 1];
                  sumB += data[p + 2];
                  count += 1;
                }
                if (count > 0) {
                  /* 反解遮罩得到「顶栏在该处的最终观感」—— 推导与踩过的坑见 captionColorFor() */
                  var resolved = captionColorFor(
                    { r: sumR / count, g: sumG / count, b: sumB / count },
                    scrim
                  );
                  fill = "rgb(" + resolved.r + ", " + resolved.g + ", " + resolved.b + ")";
                }
              }
            }
          }
        } catch (err) {
          fill = null; // canvas 被污染 / 读取失败 → 回落
        }

        if (disposed) return;
        setFill(fill || "");
      };
      image.onerror = function () {
        if (pending === image) pending = null;
        if (disposed) return;
        activeImage = null;
        setFill("");
      };
      image.src = url;
    }

    function dispose() {
      disposed = true;
      clearPending();
      activeImage = null;
    }

    return { update: update, dispose: dispose };
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
   * 建立轮询器：前 60s 每 10s 一次，之后每 180s 一次；
   * 页面隐藏时跳过（`document.hidden`），回前台立即补一次。
   */
  function createPoller(routePath, onStateChanged) {
    var startedAt = Date.now();
    var timer = null;
    var stopped = false;
    var inFlight = false;
    var lastVersion = null;

    function interval() {
      return Date.now() - startedAt < FIRST_POLL_WINDOW_MS
        ? FAST_POLL_MS
        : SLOW_POLL_MS;
    }

    function schedule() {
      if (stopped) return;
      timer = setTimeout(tick, interval());
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
          var changed = version !== lastVersion;
          lastVersion = version;
          if (!changed) return;
          onStateChanged({
            version: version,
            hasImage: state.hasImage === true,
            isDefault: state.isDefault === true,
            backdrop: typeof state.backdrop === "string" ? state.backdrop : ""
          });
        })
        .catch(function () {
          /* 网络/解析失败：静默跳过本轮，下一轮继续（不打断现有外观） */
        })
        .then(function () {
          inFlight = false;
          schedule();
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

    /** 立刻跑一轮（回到前台时补一次，不等下一个定时点）。 */
    function poke() {
      if (stopped || document.hidden || inFlight) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      schedule();
    }

    return { start: start, stop: stop, seed: seed, poke: poke };
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

        /* Windows 标题栏（右上角窗口按钮那条）：探针在本页，规则已在 OVERRIDE_CSS 里，
         * 这里只需要把采样出来的近似色写进 <html>。 */
        var captionSampler = createCaptionSampler(
          setCaptionFill,
          typeof boot.scrim === "string" ? boot.scrim : "rgba(0,0,0,.55)"
        );

        /* ★ 照片层不创建任何 DOM 节点：只往 <html> 写一个自定义属性，
         * 由 CSS 里的 :root::before 消费（见 OVERRIDE_CSS 的图层约束注释）。
         * 首版这里 appendChild 了一个 position:fixed 的 div → 画在整个应用之上
         * → 界面全黑（第一次事故）。 */
        var photoLayer = createPhotoLayer();

        /* 首帧：宿主已经给了我们 URL / 是否有图，直接铺上，不等轮询 */
        var bootVersion = typeof boot.version === "string" ? boot.version : "";
        /* 当前照片地址：轮询换图与「窗口缩放后重采标题栏色」都要用它。 */
        var lastImageUrl = "";

        /** 换图 + 同步重采标题栏近似色（两件事必须成对，故合并成一个入口）。 */
        function applyImage(url) {
          if (typeof url === "string" && url.length > 0) {
            lastImageUrl = url;
            photoLayer.swap(url);
            captionSampler.update(url);
          } else {
            lastImageUrl = "";
            photoLayer.showFallback();
            captionSampler.update("");
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
          applyImage(
            routePath +
              "/background?v=" +
              encodeURIComponent(state.version || String(Date.now()))
          );
        });
        poller.seed(bootVersion);
        poller.start();
        cleanup.push(function () {
          poller.stop();
        });

        /* 窗口尺寸变化不重算背景（cover 自适应），但**标题栏采样点会变**：
         * 窗口宽度变了，同一个屏幕点对应的图片像素也变了 ⇒ 防抖后重采一次。
         * 定时器由 cleanup 负责清（unref + 卸载时 clearTimeout），不必挤进 timers 数组。 */
        var resizeTimer = null;
        var resizeHandler = function () {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(function () {
            resizeTimer = null;
            captionSampler.update(
              typeof lastImageUrl === "string" ? lastImageUrl : ""
            );
          }, 200);
          if (resizeTimer && typeof resizeTimer.unref === "function") {
            resizeTimer.unref();
          }
        };
        window.addEventListener("resize", resizeHandler);
        cleanup.push(function () {
          window.removeEventListener("resize", resizeHandler);
          if (resizeTimer) {
            clearTimeout(resizeTimer);
            resizeTimer = null;
          }
        });

        /* 可见性恢复时补一次轮询（背景用 cover 自适应，无需重算尺寸） */
        var visibilityHandler = function () {
          if (document.hidden) return;
          poller.poke();
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
            /* 标题栏那一摊：先停采样，再摘掉写在 <html> 上的近似色
             *（<style> 由下面统一的 CSS_ID 回收逻辑处理）。 */
            captionSampler.dispose();
            setCaptionFill("");
            document.documentElement.removeAttribute(HTML_ATTR);
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
