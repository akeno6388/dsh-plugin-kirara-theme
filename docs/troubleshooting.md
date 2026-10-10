# 故障排查

## DevTools 核对脚本

刷新 GUI 后按 `F12` 打开 DevTools，逐条核对。

### 外观层在不在

```js
// ① 插件全局态（宿主注入 + 客户端读回）
window.__KIRARA_THEME__
// → { routePath:"/kirara-theme", imageUrl:"/kirara-theme/background.jpg?v=...",
//     isDefault:false, version:"...", backdrop:"..." }

// ② 标记属性（外观层已激活的唯一开关）
document.documentElement.getAttribute('data-kirara-theme')   // → "kirara"

// ③ 两个图层（挂在 html 的负 z 伪元素上，没有 DOM 节点）
getComputedStyle(document.documentElement, '::before').backgroundImage
// → url("/kirara-theme/background.jpg?v=…")（照片层；无图时是深色渐变）
getComputedStyle(document.documentElement, '::after').backgroundColor
// → rgba(0, 0, 0, 0.55)（遮罩层）

// ④ 样式表（两个 data 属性缺一不可，否则卸载时回收不掉）
document.querySelector('style[data-plugin-css="@kirara/dsh-plugin-kirara-theme/client.css"]')

// ⑤ 首屏注入层（宿主半，在 <head> 里，先于客户端脚本）
[...document.head.querySelectorAll('style')].some(s => s.textContent.includes(':root::before'))
// → true
```

第 ⑤ 条之所以能区分两份样式：客户端那份的规则是 `:root[data-kirara-theme]::before`，
不含连续子串 `:root::before`，所以这条断言只会命中宿主注入的首屏样式。

### 配色值对不对

```js
// ① 三列的磨砂值（切换 DSH 明暗主题后重跑）
getComputedStyle(document.querySelector('[class*="_sidebarCol"]')).backgroundColor
// 深色 → rgba(20, 22, 28, 0.58) / 浅色 → rgba(249, 250, 252, 0.58)

getComputedStyle(document.querySelector('[class*="_centerCol"]')).backgroundColor
// 深色 → rgba(16, 18, 24, 0.86) / 浅色 → rgba(252, 252, 253, 0.86)

getComputedStyle(document.querySelector('[class*="_rightbarCol"]')).backgroundColor
// 同内容列

// ② 外框透明（让整屏背景露出来）
getComputedStyle(document.querySelector('[class*="_frame"]:has([class*="_sidebarCol"])')).backgroundColor   // → rgba(0, 0, 0, 0)

// ③ 内层实色底是否已清掉（没清掉的话上面几条半透明等于白设）
getComputedStyle(document.querySelector('[class*="_sidebarCol"] [class*="_root"]')).backgroundColor   // → rgba(0, 0, 0, 0)
getComputedStyle(document.querySelector('[class*="_root"][data-phase]')).backgroundColor   // → rgba(0, 0, 0, 0)

// ④ 侧栏右上角圆角（仅桌面壳生效）
getComputedStyle(document.querySelector('[class*="_sidebarCol"]')).borderTopRightRadius   // → "16px"

// ⑤ Windows 顶栏：整条透明露图，且拖拽区必须还在
const frame = document.querySelector('[class*="_frame"]:has([class*="_sidebarCol"])')
getComputedStyle(frame).backgroundColor              // → rgba(0, 0, 0, 0)
getComputedStyle(frame, '::before').backgroundColor  // → rgba(0, 0, 0, 0)
getComputedStyle(frame, '::before').webkitAppRegion  // → "drag"
```

## Windows 标题栏底色

右上角最小化 / 最大化 / 关闭那条底栏**不是 DOM**，是 Windows 合成器画的
（Electron `titleBarOverlay` → 主进程 `setTitleBarOverlay()`）。链路是：

```
preload（在本页运行 —— window === window.top）
  ├─ 建一个隐藏探针 span：background-color:var(--dsw-specific-sidebar-fill)
  ├─ 用 canvas 把它读成 rgba(...)（nativeColor()）
  └─ ipcRenderer.send('dsh-desktop:windows-appearance', lang, color, symbolColor)
        ↓（主进程校验：senderFrame.url 必须以 dsh-app://app/ 开头）
     mainWindow.setTitleBarOverlay({ color, symbolColor })
```

### 探针就在本页

`window === window.top`、`window.top.document === document`，
`document.querySelector('span[style*="--dsw-specific-sidebar-fill"]')` 直接命中。
所以规则写进 `OVERRIDE_CSS` / `bootCss()` **即可生效**，不需要任何跨文档注入。

> **曾经判断错**：早期一条 `isTop:false` 的探测被误读成「GUI 跑在 iframe 里」，
> 于是实现了「往 `window.top.document.head` 注入独立样式表」，并用
> `if (window.top === window) return null` 做守卫 —— 在当前结构下那个守卫**必然命中**，
> 整条链路静默失效，症状是右上角永远不变且没有任何报错。
> 别再引入跨文档注入或 `window.top` 守卫。

### 「标题栏不吃任何透明值」是旧结论，已被推翻

早期这里记过「只有不透明色才生效」，并据此做了采样近似色。复测确认**那个结论是错的**，
错的根源有两条 —— 都是链路问题，不是渲染限制：

- 显式 `transparent` **过不了宿主的值校验**。主进程只放行
  `/^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu` —— 关键字根本不会被推送，颜色自然「毫无变化」。
- 变量写在本页 `<html>` 的**行内样式**上不触发重推。宿主只在 root 的 `lang`、
  `body` 的 `data-ds-dark-theme` / `style`、`head` 的 childList/subtree/characterData 变化时
  重新读探针；改 `<html>` 的 `style` 不在其中（首屏能生效靠的是 `head` 里那次样式插入，
  之后换图重算的值就送不出去了）。观察到的「怎么改都不动」多半是这一条。

**决定性复测**（打包版 Electron 44.0.0、150% DPI；页面顶 40px 纯品红 `#ff00ff`、其余纯绿，
读取窗口按钮区的像素普查）：

| 推过去的 overlay 色 | 按钮区像素 | 结论 |
| --- | --- | --- |
| `rgba(0, 0, 0, 0)` | 品红 6006 / 暗色 78（只有三个字形笔画） | 底色**完全透明**，页面原样透出 |
| `rgba(255, 255, 255, 0.004)`（插件实际推的值） | 品红 6005 / 暗色 78 | 与 alpha=0 无差别 ⇒ 1/255 的白膜不可见 |
| `#1b1b1c`（不透明） | 暗色 4923 / 品红 1188 | 铺出一条实色带 |

**怎么复测**：写一个最小 Electron app（同样的 `titleBarStyle:'hidden'` +
`titleBarOverlay:{ height:40, color:X }`），页面顶部 40px 铺纯品红 `#ff00ff`、其余纯绿；
窗口显示后用 `desktopCapturer.getSources()` 抓屏，在「窗口右边缘向左 170px × 顶部 2–38px」
这块做像素普查：

- 透明 ⇒ 绝大多数像素是品红，只有约 78 个暗像素（三个字形笔画）
- 不透明 ⇒ 几千个实色像素（推 `#1b1b1c` 时是 4923 个暗像素 + 1188 个品红）

这套探针不碰宿主进程、也不依赖插件。结论：**推带 alpha 的颜色就能让那条带子彻底消失**。

### 其它入口都不通

`dshDesktop` 上没有任何相关方法（只有 `protocolVersion / browser / deviceInfo / keyboard / shortcuts /
updates / hasApiKey / setActive / ready / failed / open / setBounds / close`），
monkey-patch `ipcRenderer.send` 也不是可行方案（preload 的 `require` 在隔离世界，插件拿不到那个对象）。
探针的计算后底色是**唯一**入口。

### 本插件的做法

`OVERRIDE_CSS` / `bootCss()` 里两条普通规则，把探针的 `background-color` 直接设成全透明
（只改这个探针元素的声明，不覆盖 `--dsw-specific-sidebar-fill` 本身）：

```css
:root[data-kirara-theme] span[style*="--dsw-specific-sidebar-fill"]{
  background-color:rgba(255,255,255,0.004)!important;
}
:root[data-kirara-theme] body[data-ds-dark-theme] span[style*="--dsw-specific-sidebar-fill"]{
  background-color:rgba(0,0,0,0)!important;
}
```

- **alpha ≈ 0** ⇒ 宿主把那层底色设成全透明，顶栏（照片 + `html::after` 遮罩）原样透出。
- **浅色那条写 1/255（`0.004`）而不是 0**：宿主读到的颜色会过一次 canvas
  （`fillStyle` + `fillRect` → `getImageData`），alpha=0 时 RGB 被抹成 0
  ⇒ 推过去就是 `rgba(0, 0, 0, 0)`，「浅色兜底白」留不住；1/255 能原样过关。
  实测这条带子的观感与 alpha=0 完全一致，看不到任何白膜（见下表的复测数据）。
- **RGB 分量不是随便给的**：宿主若只取 RGB（旧实现如此），带子会退回那个颜色 ⇒
  浅色主题白 / 深色主题黑，正是「实在透明不了」时的兜底实色。
- **深色主题必须单独一条**：`PD` 前缀特异度更高，否则会被浅色那条的 `rgba(255,255,255,0)` 吃掉。
- 系统开启「降低透明度」时，同一段媒体查询里把探针改回 `var(--dsw-specific-sidebar-fill)`，
  与三个列一起退回实色 —— 那里深浅两套前缀都要写，理由同上。

客户端半**不再参与**这条链路：`createCaptionSampler()` 与 `--kirara-caption-fill` 已随本次修复删除
（采样只能给整条带子一个颜色，而带子底下的照片横向有变化，注定有色差）。

> **不允许**为了这条链路去改 `resources/app.asar` 里的 `lib/main.js` / `lib/preload-app.cjs`：
> 那是 DSH 安装目录、会被升级覆盖，改它等于破解宿主。

> 透明底上三个按钮图标直接压在顶栏上：图标颜色仍来自探针的 `color`
>（`var(--dsw-alias-label-primary)`），对比度只由 `.55` 黑遮罩兜底 —— 与顶栏其余控件同一层遮罩。

## 事故一：所有工具调用崩在 `Cannot read properties of undefined (reading 'prepare')`

**症状**：重启后**每一个**工具调用（包括内置 `read` / `pwsh`）都崩在
`Cannot read properties of undefined (reading 'prepare')`，DSH 会话直接不可用。

**根因**：把宿主包写进 `dependencies` ⇒ pnpm 把 `@deepseek-ai/*` 拷进
`profiles/desktop/node_modules` ⇒ `app-boot` 的 `routeScoped` 选中 profile 本地那份物理副本
（`kind:'native'`）⇒ 进程内出现**两个不同的 `TOOL_RUNTIME_SCHEDULER` symbol** ⇒
`ctx.tools[SYMBOL]` 读不到 ⇒ 所有派发路径在 `undefined.prepare(...)` 上炸掉。

**修复**：宿主包只声明在 `peerDependencies`，永不安装；并用 `deploy.mjs` 的不变量
1 / 1c / 2 / 4 把它钉死。

## 事故二：`bootCss()` 与 `OVERRIDE_CSS` 漂移 ⇒ 首屏闪一下

首屏样式由两处产出，声明体必须逐条对齐。两处只允许有下面两种差异：选择器前缀不同、
`bootCss()` 多一条动态的 `--kirara-theme-photo` 行。

改任何一边的视觉规则而另一边没改，就会出现「首帧一个样、脚本跑完变另一个样」的闪烁。

**现在这条约束是可执行校验的**：`node scripts\check-css-parity.mjs` 会直接从两份源码里取出规则数组
求值，把客户端前缀规范化成裸 `:root` 后逐行比对，退出码 0 才算同源。

## 事故三：不要给 `body` 写 `color`

早期版本为了统一文字颜色，在 `body` 上写了：

```css
color: var(--dsw-alias-text-primary, #f5f6f8) !important;   /* ❌ 已删除，禁止恢复 */
```

后果是**整个界面文字、图标全部消失**（只剩背景图，只有「应用 / 编辑」两个按钮可见）。

根因有两层：

1. **`--dsw-alias-text-primary` 这个 token 根本不存在**。真实 token 是 `--dsw-alias-label-primary`。
   自定义属性取不到值时回退到字面量 `#f5f6f8`，于是近白色永远生效。
2. 该声明带 `!important` 且落在 `body` 上，**继承会污染全树**：所有没自己指定 `color` 的文本、
   图标都变成近白色 —— 浅色主题下等于白底白字。

修复：两个半的 CSS 里删除了全部 `color` 声明，现在只剩 `background-color:`。

## 事故四：不要用 append 的 div 当图层

更早的版本把背景板做成两个 append 到 `<body>` 的元素：

```
#kirara-theme-backdrop  { position: fixed; inset: 0; z-index: 0; }
#kirara-theme-scrim     { position: fixed; inset: 0; z-index: 1; }
```

后果：**AppFrame 被整个盖住** —— 文字与侧栏不可见，底部还多出一条渐变遮罩。

根因见[架构文档](architecture.md)的绘制顺序：`z-index:0` 已经是「`z-index>=0` 的定位元素」那一档，
AppFrame 在文档流里是 `z-index:auto`，因此 0 / 1 不是「在其下」而是**在其上**。

修复：改成 `html` 上的负 z 伪元素加 `body` 透明，页面里不再有任何插件 DOM 节点。

## 事故五：关掉插件后外观还在（首屏样式没人回收）

**症状**：在插件列表里关掉开关后，背景图、`.55` 遮罩、三列半透明**原样留着**，
只有刷新页面才消失；打开开关倒是立刻生效。

**根因**：外观其实来自两份 `<style>`：

| 样式 | 谁写的 | 运行时关插件时 |
| --- | --- | --- |
| `OVERRIDE_CSS`（客户端自己的） | 客户端挂载时 `document.head.appendChild` | 会消失：`dsh-client-modules` 随模块回收，插件自己的清理也会删 |
| `bootCss()`（宿主写进索引页的） | `webserver/index-inject` 在**渲染索引页时**拼进 HTML 文本 | **不会消失**：它是静态文本，宿主进程的 `ctx.effect` 清理只能「以后不再注入」，够不着已经送进浏览器的这一份 |

后者用的是裸 `:root` 选择器（客户端那份是 `:root[data-kirara-theme]`，属性一摘就失效），
所以卸载后它继续生效 ⇒ 整套外观留在页面上。

**修复**：宿主注入时在样式文本前拼上 `BOOT_MARKER`（`/*! kirara-theme-boot */`），
客户端卸载时扫 `document.head` 里的 `<style>`、按标记把那一份摘掉。

⚠️ 标记**必须拼在 `bootCss()` 的返回值之外**。塞进规则数组会直接破坏
`check-css-parity.mjs` 的「逐行同源」断言 —— 那是另一条硬约束。

**为什么不用「往行上加属性」**：`kind:"style"` 行渲染出来就是裸 `<style>…</style>`，
渲染器不给它任何属性，所以只能靠文本标记认领。

**自检**：`node scripts\deploy.mjs --check` 的第 7 项断言两个文件里的标记字面量一致、
且卸载路径真的调了 `removeBootStyles()`。这条契约漂移的表现是**静默退化**
（不报错，只是关不掉），只能靠断言和现象守。

## 常见故障速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 装完毫无变化 | **首次登记**后没有完全重启 DSH，或 bundles 里没注册 | 重启 DSH；检查 `dsh.profile.bundles`（登记过之后，开关是即时的，不需要重启） |
| 关掉插件开关后背景 / 遮罩 / 半透明还在 | 宿主首屏样式没被回收（`BOOT_MARKER` 漂移，见事故五） | `node scripts\deploy.mjs --check` 看第 7 项；刷新页面可临时还原 |
| 打开插件后先是渐变、过一会儿才出图 | 客户端没在挂载时立刻探到 `state.json` | 正常 ≤1.5s（暖机重试）；一直不出图按下一行查 |
| 只有深色渐变 | 还没拿到远端图 | 检查服务器 302 与版本头；`POST /kirara-theme/refresh` |
| 主界面是纯色面板 | 内层实色底没清掉（宿主换了容器 / 改了结构） | 见[已知限制](limitations.md)，用 DevTools 核对 `[class*="_root"][data-phase]` 与内容列内的面板根 |
| 菜单和浮层都变半透明 | 误改了 `--dsw-specific-sidebar-fill` | 回退到只给列铺底色、内层清成 `transparent` |
| 右上角标题栏出现实色带 | ① 探针规则没匹配到（探针行内 style 的文本变了）；② 宿主不吃带 alpha 的 overlay 色 ⇒ 退回 RGB 分量 | 核对探针元素的计算后 `background-color` 是否为 `rgba(...,0)`（浅色白 / 深色黑是兜底实色）；见上文「Windows 标题栏底色」 |
| 首屏闪一下 | 两份 CSS 不同源 | `node scripts\check-css-parity.mjs` |
| 工具调用全崩在 `undefined.prepare` | profile 里有宿主包物理副本 | `node scripts\deploy.mjs --check` 定位，然后重新部署 |
