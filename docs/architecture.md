# 架构与外观实现

## 代码结构

```
dsh-plugin-kirara-theme/
├── package.json          # 包契约：type/main/exports/files/dsh.client + dsh.bundle.patch
├── cordis.patch.yml      # bundle patch（顶层 YAML 数组，config 整行替换）
├── lib/
│   ├── index.js          # 宿主半：Config / 路由 / 同步 / 磁盘缓存 / bootCss / bootGlobal
│   └── client.js         # 客户端半：外观 CSS / 背景图层 / 轮询 / 换图 / 标题栏近似色 / 清理
├── locale/{zh,en}.json   # 插件列表里显示的名称与描述
├── scripts/
│   ├── deploy.mjs             # link + 部署 + 11 项不变量自检
│   └── check-css-parity.mjs   # 首屏 CSS 与客户端 CSS 的「逐条同源」断言
└── docs/
```

这是一个**双半插件**：宿主半跑在 DSH 主进程里负责同步与路由，客户端半注入到 Web GUI 里负责外观。

## 各部分实现位置

| 能力 | 实现位置 |
| --- | --- |
| 外观层（背景 + 遮罩 + 三列半透明 + 侧栏圆角 + Windows 顶栏透明 + 侧栏底部渐隐去除 + 主界面底部渐变去除） | `lib/client.js`，注入一个 `<style>` |
| 侧栏透明度 | `lib/index.js` 与 `lib/client.js` 的 `SIDEBAR_ALPHA` |
| Windows 标题栏底色 | `lib/client.js` 的 `setCaptionFill()` / `createCaptionSampler()`，加 `OVERRIDE_CSS` 里那条探针规则 |
| 首屏防白闪 | `lib/index.js` 的 `bootCss()`，以 `kind:"style"` 注入 `<head>` |
| 背景图服务器同步 | `lib/index.js` 的 `syncOnce()` |
| 同源背景路由 | `lib/index.js` 的 `createRouteHandler()` |
| 版本变更轮询与换图 | `lib/client.js` 的 `createPoller()` / `createPhotoLayer()` |

## 图层为什么必须挂在 `html` 的负 z 伪元素上

Web shell 只注册了 `root` 一个 slot，`#root` 里只有 AppFrame。所以：

- **纯 slot 挂载无法把图层放到最底层** —— 没有比 AppFrame 更低的位子
- `shell.leading` 只在 macOS 且侧栏折叠时才挂载，Windows / Web 上不可用

因此外观层只能是两种手段的组合：往 `document.head` 注入一个自建 `<style>` 承载全部规则，
然后在 `<html>` 上用**负层级伪元素**做图层 —— `html::before` 放背景图，`html::after` 放半透明黑遮罩，
两者都是 `position:fixed; inset:0; z-index:-1; pointer-events:none`。

按 CSS 2.1 附录 E 的绘制顺序，根堆叠上下文里的顺序是：

```
html 背景/边框 → 负 z 的子堆叠上下文（html::before / html::after）
→ 文档流内非定位后代（body 的背景）→ 行内内容 → z-index>=0 的定位元素
```

由此得到两条硬结论：

- **`body` 必须透明**（`body { background-color: transparent !important }`），
  否则 body 自己的背景色会画在负 z 伪元素**之上**，把背景图整块挡住。
  这是这条链路唯一承重的规则，不能删。
- 给 `html` 设 `background-color` 是**无效果的** —— 它本就是最底一层，不解决问题。

**绝不要用 DOM 节点做图层**：任何 `position:fixed` 且 `z-index>=0` 的节点
（包括一个 append 到 `<body>` 末尾的 `<div>`）都会画在**整个应用之上**，
表现为「界面只剩背景图、文字和侧栏全都不见了」。唯一安全的位置就是 `html` 上的负 z 伪元素。

两个伪元素同为 `z-index:-1`，因此按**树序**决定上下：`::after`（遮罩）在 `::before`（背景图）之后，
所以遮罩稳定盖在图片上。

### 背下来这条

```
负 z 子堆叠上下文 < body 背景 < 文档流内内容 < 任何 z-index>=0 的 fixed 节点
```

## 复刻自 Kirara 的哪条链路

| Kirara_Server（WinUI 3） | 本插件（宿主半） |
| --- | --- |
| `Services/BackgroundService.cs` | `syncOnce()` / `ensureSynced()` |
| 30 分钟冷却 + 强制比对一次 ETag | `syncIntervalMinutes: 30` + equal-version 零下载 |
| `GET /api/resources/home-background`（302 预签名） | `fetchFollowing()`：手动吃第一跳拿版本号，再跟随 `Location` |
| `CacheFileName = "background_cache.enc"` | `cacheDir/background.bin` + `state.json` |
| 404 记日志保留旧图；异常保留旧图 | 同样：失败保留当前字节，绝不把界面打回空白 |
| `DefaultBackgroundAsset` 降级默认图 | `DEFAULT_BACKDROP_CSS` 渐变（不是图片文件） |
| 换图 300ms 交叉淡入 | `swap()`：离屏 `new Image()` 预解码成功后才一次性换 `--kirara-theme-photo` |
| `HomeOverlay.Opacity = 0.55` | `html::after` 遮罩层恒为 `rgba(0,0,0,.55)`，浅色下也不变 |
| 左侧栏半透明 | `[class*="_sidebarCol"]` 铺 `rgba(20,22,28,.58)`（深）/ `rgba(249,250,252,.58)`（浅） |
| 主界面 / 右侧栏半透明 | `[class*="_centerCol"]` + `[class*="_rightbarCol"]` 铺 `rgba(16,18,24,.86)`（深）/ `rgba(252,252,253,.86)`（浅） |
| 圆角窗口外壳 | 内容卡左上角本就是宿主原生的 `16px`；插件给侧栏列补上对称的右上角圆角 |

**关于「淡入」**：这条链路没有淡入。自定义属性的取值是**离散**的，不能 transition ——
两边都是先用 `new Image()` 预加载并解码，解码完成才直接把属性换成新值。客户端独占这一步，
宿主那份只负责首帧的 URL，所以不会闪两次。

## 外观 CSS 的九条硬约束

写在 `lib/client.js` 的 `OVERRIDE_CSS` 注释块里。改视觉规则之前先读一遍。

1. **不覆盖 `--dsw-specific-sidebar-fill`**。该 token 同时被菜单、弹出层、`--dsw-alias-button-elevated-fill`
   系列复用 —— 改它会让**所有浮层一起变半透明**。正确做法是只给三个列元素
   （`[class*="_sidebarCol"]` / `[class*="_centerCol"]` / `[class*="_rightbarCol"]`）铺半透明底，
   并把内层容器原来的不透明底清成 `transparent`。
2. **不用 `backdrop-filter`**。Kirara 首页没有任何亚克力或模糊（整屏照片已经盖住窗口级 Mica）。
3. **不用 `color-mix` / `@supports`**。统一写死 `rgba()`，宿主注入的首帧 CSS 与客户端才能逐字节对齐，
   也避开旧 Chromium 的解析差异。所谓「写死」是指写**算式**：透明度经 `SIDEBAR_ALPHA` 常量参与拼接，
   两个文件里必须同名同值；拼接结果取整到三位小数，避免
   `1 - 0.42 = 0.5800000000000001` 这种浮点毛刺破坏逐字节一致。
4. **绝不写 `color`**。任何落在 `body` / `html` 上的 `!important` 颜色都会被所有子元素继承，
   直接把整个 harness 的文字与图标染成同色 —— 这是「只剩背景图、内部 UI 全看不见」那次事故的根因。
   要引用的 token 名也必须是真名（正文主色是 `--dsw-alias-label-primary`；
   `--dsw-alias-text-primary` 在 `theme-client` 里根本不存在，写错的 token 会静默退化成字面量兜底色）。
   详见[故障排查](troubleshooting.md)。
5. **主题只认 `body[data-ds-dark-theme]`**（属性存在 = 深色，不存在 = 浅色）。这是 DSH 唯一可信的
   主题真值 —— **没有** `data-ds-light-theme`，也**没有** `data-color-scheme`。
6. **客户端每条选择器都带 `:root[data-kirara-theme]` 前缀**，特异度 (0,2,0) 稳定压过布局层的 (0,1,0)，
   与注入先后无关。深色分支追加一个后代后缀 ` body[data-ds-dark-theme]`（因为主题属性挂在 `<body>` 上），
   写成 `:root[data-kirara-theme] body[data-ds-dark-theme]`。
   **不能**写成 `:root[data-kirara-theme][data-ds-dark-theme]` —— 那是「同一个元素同时带两个属性」，
   `<html>` 上永远没有 `data-ds-dark-theme`，深色规则**永不命中**；
   **也不能**写成 `body[data-ds-dark-theme] :root[…]`，那是错误的后代选择器。
   宿主半（`bootCss()`）用裸 `:root` 前缀，深色分支即 `:root body[data-ds-dark-theme]`。
7. ★ **选择器只写 CSS Modules 的「本地名后缀」，绝不写哈希前缀**。
   `.module.css` 编译出来的类名是 `<哈希前缀>_<本地名>`：本地名来自源码、跨宿主版本稳定，
   哈希前缀**每次构建都可能变** —— 官方 `0.2.0-rc.2` 出的是 `.BynINW_sidebarCol`，
   EduWork 内置的新版 DSH 把同一份源码编译成 `.pI_x6G_sidebarCol`。写死前缀 ⇒ 换一个宿主构建
   就整层静默失效（症状：照片被宿主的不透明列与面板盖死、三列都不透明）。
   后缀唯一性已在客户端全量核对：`_sidebarCol` / `_centerCol` / `_rightbarCol` / `_composerSeat` /
   `_embeddedBody` / `_fade` 各只对应一个前缀；`_frame`（11 个）与 `_root`（44 个）不唯一 ⇒
   用「结构 / 属性」锚点区分：
   - **外框** = 唯一「包含侧栏列」的 `_frame`：`[class*="_frame"]:has([class*="_sidebarCol"])`
     （`:has()` 宿主自己也在用）；
   - **会话根** = 唯一带 `data-phase` 的 `_root`：`[class*="_root"][data-phase]`
     （宿主 CSS 用的就是同一依据）；
   - **侧栏 / 右侧栏内的面板根** = 该列内部**全部** `_root`。宿主把侧栏拆成了多个可切换面板、
     每个面板自带一个 `_root`，逐个点名只是把哈希依赖换个地方放。
   菜单与浮层走 `createPortal(…, document.body)` 渲染，落在列之外，不受这几条影响。
   降级后果是「该处不再半透明 / 圆角消失」，布局不会被破坏。
   核对方式：解出 `@deepseek-ai/dsh-client-ui-layout`（或 `-sidebar` / `-conversation`）的
   `lib/client.js` 搜本地名后缀。
8. **磨砂只能由「列」承担，内层实色底必须清成 `transparent`**。宿主在两处内层根上各自铺了不透明底：
   侧栏内部的每个面板根（`--dsw-specific-sidebar-fill` / `--dsw-alias-bg-base`）、
   会话主界面根（`--dsw-alias-bg-base`），还有一条把输入区底部收口到实色的
   `[class*="_composerSeat"]` 渐变。只改列的颜色而不管内层，后果有两个方向：
   内层不动 ⇒ 实色把照片整块盖住（侧栏半透明看得见背景，主界面却是纯色面板）；
   内层也铺同色半透明 ⇒ 两层叠加反而推回近实心（`0.58` 叠 `0.58` ≈ `0.82`）。
   准确配方是：**透明度只在列上设一次，内层一律 `transparent`**。
9. **Windows 顶栏是「零透明度」的唯一例外**：顶栏那条不设任何透明度，直接 `transparent` 露出背景图层。
   宿主在顶栏上有**两层**不透明来源，必须一起清：外框 `_frame`（给 `padding-top` 预留的顶栏高度
   填的 `--dsw-specific-sidebar-fill`）与外框 `_frame:before`
   （`height:var(--dsh-windows-titlebar-height)` 的全宽拖拽条，自己又铺了一层同色底）。
   只清 `:before` 会剩外框一层，只清外框会剩 `:before` 一层，**症状都是顶栏比下方内容区更亮**。
   只清 `background`，**保留 `:before` 的 `-webkit-app-region:drag`**（窗口拖拽几何，宿主给的）。
   这条规则带 `:has([class*="_sidebarCol"])` 结构锚点，特异度高于宿主外框那条，所以显式把外框
   写进选择器列表，不靠「作者样式表内后者胜」这种顺序依赖。
   对照第 1 条：这里清的是**具体元素**上的声明，没有去覆盖 `--dsw-specific-sidebar-fill` 这个 token 本身，
   菜单与浮层不受影响。

### 另外两条去掉渐变的规则

它们不是上面那九条约束，但同样是刻意的设计，改动前需要知道为什么：

- **侧栏底部渐隐**：`[class*="_sidebarCol"] [class*="_fade"]`（24px，`linear-gradient(to bottom, transparent,
  var(--dsw-specific-sidebar-fill))`）属于「不透明侧栏」时代的产物 —— 列表滚到底时用一截实色把文字压掉。
  侧栏已经是半透明照片后，这截实色终点与整块面板不再一致，所以清成 `transparent`。
  不要改它的 `height` / `position`：它只是视觉遮罩（`pointer-events:none`），
  清掉底色后列表滚动与命中区完全不变。（宿主自己也认为它不适合透明场景：darwin 下直接 `display:none`。）
- **输入区底座渐变**：`[class*="_composerSeat"]` 的渐变清成 `transparent`，同时覆盖
  `[data-content-phase=active]`（内嵌会话 body 用的是另一个属性名，宿主为它写了一份同款渐变）。
  代价是滚到输入框下方的正文不再被 36px 实色带遮住，会一直透到照片上。

## 侧栏透明度旋钮

三个列的半透明底里，**侧栏是最透的**（内容列 / 右侧栏固定在 `.86`）：

| 列 | 实心度 | 对应常量 |
| --- | --- | --- |
| `[class*="_sidebarCol"]` | `.58` | `SIDEBAR_ALPHA = 0.42` |
| `[class*="_centerCol"]` / `[class*="_rightbarCol"]` | `.86` | 写死在规则里 |

**`SIDEBAR_ALPHA` 的命名语义是「透明度」，不是「不透明度」**：

```
写进 CSS 的实心度 = 1 - SIDEBAR_ALPHA
```

所以数字越大 = 越透明。这是刻意反着命名的 —— 若叫 `SIDEBAR_OPACITY`，想「更透」的人会顺手把值
从 `.72` 改到 `.85`，结果更实心。

改它需要**同时**改两个文件里同名同值的常量，否则首屏 CSS 与客户端 CSS 会漂移。

两个连带的注意事项：

1. 同一条规则还出现在无障碍媒体查询里（`prefers-reduced-transparency:reduce`），
   那里回落到宿主的 `var(--dsw-specific-sidebar-fill)`，与透明度无关，不用改。
2. 别顺手去调 `--dsw-specific-sidebar-fill`（第 1 条约束）—— 那个 token 同时被菜单与所有浮层复用。

## 首屏与客户端 CSS 必须逐字节同源

首屏样式由**两处**产出，声明体必须逐条对齐：

- `lib/index.js` 的 `bootCss()`：以 `kind:"style"` 注入 `<head>`，**先于**客户端脚本执行，决定首帧
- `lib/client.js` 的 `OVERRIDE_CSS`：客户端挂载后注入 `<style>`，接管后续

两处只允许有下面两种差异：

1. **选择器前缀不同** —— `bootCss()` 用裸 `:root`，因为此时 `data-kirara-theme` 属性还没写上
   （属性是客户端挂载后才设的）；`OVERRIDE_CSS` 用 `:root[data-kirara-theme]`，正好高出一个属性选择器
   级别，所以交接后客户端那份稳定压过宿主那份，不需要比注入先后。
2. **`bootCss()` 多一条动态的 `--kirara-theme-photo: url(…)` 行**，把已有缓存图的 URL 直接写进首帧。

改任何一边的视觉规则，**另一边必须同步改**，否则会出现「首帧一个样、脚本跑完变另一个样」的闪烁。
`bootCss()` 的文档注释里已经写了这条警告，别删。

这条约束是可执行校验的：`node scripts\check-css-parity.mjs` 会直接从两份源码里取出规则数组求值，
把客户端前缀规范化成裸 `:root` 后逐行比对（`--dump` 还能打印首屏渲染出的完整 CSS）。

> `bootCss()` 那条 `photo` 规则里的 `--kirara-theme-photo` **绝不能加 `!important`**：
> 客户端换图是把新的 `url(...)` 内联写在 `<html>` 的 `style` 上（`setProperty`），
> 内联声明本就该压过作者样式表；一旦宿主那边写了 `!important`，客户端就再也换不动图了。

## 卸载与回滚是纯结构性的

卸载时按**逆序**执行清理，每步单独 try/catch：

```
clearInterval / clearTimeout → 摘 visibilitychange 监听
→ photoLayer.dispose()（置 disposed、清 pending、removeProperty("--kirara-theme-photo")）
→ document.documentElement.removeAttribute("data-kirara-theme")
→ 按 data-plugin-css 移除自建 <style>
```

**唯一的「内联写入」只有一处**：往 `<html>` 写自定义属性 `--kirara-theme-photo`。
所以回滚只需要一次 `removeProperty`，而不是「逐条还原」。除此之外插件没有改写任何既有元素的
`style`，也没有 append 任何 DOM 节点 —— 这是刻意的设计，别改成往页面里塞图层节点。

## 宿主包必须声明为 `peerDependencies`

`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 写在 `peerDependencies`，
**绝对不要**改成 `dependencies`。

一旦 pnpm 把 `@deepseek-ai/*` 拷进 profile 的 `node_modules`，`app-boot` 的 `routeScoped` 会挑中
profile 本地那份物理副本，于是宿主里出现**两个不同的 `TOOL_RUNTIME_SCHEDULER` symbol**，
`ctx.tools[SYMBOL]` 变 `undefined`，连内置的 `read` / `pwsh` 都在 `undefined.prepare(...)` 里崩掉。

完整事故经过见[故障排查](troubleshooting.md)。
