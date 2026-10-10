# 故障排查

## DevTools 核对脚本

刷新 GUI 后按 `F12` 打开 DevTools，逐条核对。

### 外观层在不在

```js
// ① 插件全局态（宿主注入 + 客户端读回）
window.__KIRARA_THEME__
// → { routePath:"/kirara-theme", imageUrl:"/kirara-theme/background.jpg?v=...",
//     isDefault:false, version:"...", backdrop:"...", scrim:"rgba(0,0,0,.55)" }

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

### 标题栏不吃任何透明值

三次实测把「真透明」彻底排除：

| 推过去的值 | 结果 |
| --- | --- |
| `rgba(0, 0, 0, 0.55)` | 界面毫无变化（被忽略，不是被压成透明） |
| `transparent`（探针 computed 直接设成透明） | 界面毫无变化 |
| `rgb(255, 0, 170)`（不透明） | 立刻变色 |

结论：`titleBarOverlay` 只接受**不透明**颜色，`transparent` 与带 alpha 的值会被 Electron 或 DWM
当作无效值直接忽略（标题栏保持上一次的颜色）。所以「直接设成透明」不是没试过，而是物理上不可行，
采样近似色是唯一手段。

### 其它入口都不通

`dshDesktop` 上没有任何相关方法（只有 `protocolVersion / browser / deviceInfo / keyboard / shortcuts /
updates / hasApiKey / setActive / ready / failed / open / setBounds / close`），
monkey-patch `ipcRenderer.send` 也不是可行方案（preload 的 `require` 在隔离世界，插件拿不到那个对象）。
探针的计算后底色是**唯一**入口。

### 本插件的做法

- `OVERRIDE_CSS` / `bootCss()` 里一条普通规则，把探针的 `background-color` 指到 CSS 变量
  `--kirara-caption-fill`（只改这个探针元素的声明，不覆盖 `--dsw-specific-sidebar-fill` 本身）
- 该变量由 `createCaptionSampler()` 算出、经 `setCaptionFill()` 写在**本页 `<html>`** 的行内样式上：
  重做 `background-size:cover` 与 `center` 的缩放与居中裁剪，在「距右边缘 60px、纵向 4px」处
  取一块 **160×28 屏幕像素**的平均色 —— 不是单像素，单点取样会让整条带子偏成那一个像素的色调

### 取色公式

```
标题栏 = 操作系统画在网页之上的一层（Electron titleBarOverlay / DWM）
       ⇒ 没有任何东西会再压在它上面，它的观感就是我们推过去的颜色 X

它底下露出的顶栏 = 照片 + html::after 遮罩 = (1-a)·photo + a·scrim

要让两者一致 ⇒  X = (1-a)·photo + a·scrim      ← 只合成一次
```

**不要把 X 写成「反解」** `(photo - a·scrim)/(1-a)`。它基于一个错误前提
（「浏览器会把遮罩再压到标题栏上」）—— 标题栏在网页之上，遮罩压不到它；
反解会让标题栏比顶栏更亮。推导已固化在 `lib/client.js` 的 `captionColorFor()` 注释里。

换图、窗口 resize（防抖 200ms）都会重采；canvas 被污染或解码失败时静默放弃，
规则回落到 `rgba(0,0,0,.55)`。卸载时 `captionSampler.dispose()` + `setCaptionFill("")` 摘掉变量。

> **不允许**为了这条链路去改 `resources/app.asar` 里的 `lib/main.js` / `lib/preload-app.cjs`：
> 那是 DSH 安装目录、会被升级覆盖，改它等于破解宿主。

> 像素级完美不可能：标题栏是整条窗口宽一个颜色，而它下面的照片横向有变化 ——
> 取小块平均色能让按钮簇附近最贴合，离得越远越可能看出轻微色差。

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

## 常见故障速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 装完毫无变化 | 没有完全重启 DSH，或 bundles 里没注册 | 重启 DSH；检查 `dsh.profile.bundles` |
| 只有深色渐变 | 还没拿到远端图 | 检查服务器 302 与版本头；`POST /kirara-theme/refresh` |
| 主界面是纯色面板 | 内层实色底没清掉（宿主换了容器 / 改了结构） | 见[已知限制](limitations.md)，用 DevTools 核对 `[class*="_root"][data-phase]` 与内容列内的面板根 |
| 菜单和浮层都变半透明 | 误改了 `--dsw-specific-sidebar-fill` | 回退到只给列铺底色、内层清成 `transparent` |
| 右上角标题栏一直是实色带 | 探针规则没匹配到，或采样失败 | 核对 `--kirara-caption-fill` 与探针元素 |
| 首屏闪一下 | 两份 CSS 不同源 | `node scripts\check-css-parity.mjs` |
| 工具调用全崩在 `undefined.prepare` | profile 里有宿主包物理副本 | `node scripts\deploy.mjs --check` 定位，然后重新部署 |
