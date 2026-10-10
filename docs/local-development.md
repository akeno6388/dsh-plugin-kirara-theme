# 本地开发

面向插件本体的开发。只想装上用的话看 [README](../README.md) 就够了。

## 挂载到 profile

`<DSH_HOME>/profiles/desktop/package.json`：

```jsonc
{
  "dependencies": {
    "@kirara/dsh-plugin-kirara-theme": "file:D:/works/Kirara Server Project/dsh-plugin-kirara-theme"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@kirara/dsh-plugin-kirara-theme"   // ← 必须加在 bundles 里，否则插件不会被加载
      ]
    }
  }
}
```

**`dependencies` 与 `bundles` 是两件事**：前者只负责把文件物化到 `node_modules`，后者才决定
「启动时加载哪些插件」。只写 `dependencies` 不写 `bundles` ⇒ 插件静默不生效。

宿主包已经写在 `peerDependencies`，**不要**改成 `dependencies`，理由见[架构文档](architecture.md)。

## 部署脚本

```powershell
cd 'D:\works\Kirara Server Project\dsh-plugin-kirara-theme'
node scripts\deploy.mjs            # 重新 link + 部署 + 12 项不变量自检
node scripts\deploy.mjs --check    # 只自检，不动文件
node scripts\deploy.mjs --enable   # 幂等确保 bundles 里有本插件
node scripts\deploy.mjs --disable  # 幂等摘掉
```

脚本会自动找到 DSH 自带的 pnpm（`…\resources\runtime\pnpm\bin\pnpm.cjs`）——
**系统 PATH 上没有 `pnpm`**，别去 `pnpm install`。

可用环境变量覆盖：`DSH_HOME`（默认 `%USERPROFILE%\.dsh`）、`DSH_PROFILE`（默认 `desktop`）、
`DSH_PNPM`（pnpm.cjs 绝对路径）。

首次部署前跑 `--check` 必然报「副本缺失」，那是预期的，`node scripts\deploy.mjs` 之后应该全绿。
pnpm 在部署时会打印 `[WARN] Issues with peer dependencies found.` —— 也是正常的，
因为宿主包被刻意声明成 peer 且不安装。

### 12 项不变量

任一失败 ⇒ exit 1。

| # | 不变量 | 为什么必须有 |
| --- | --- | --- |
| 0 | profile 已登记本插件（`dependencies` 里有） | 没登记就物化不到 `node_modules` |
| 1 | 插件清单：宿主包**不是** `dependencies` | 见[架构文档](architecture.md) |
| 1-peers | 插件清单：宿主包**声明为** `peerDependencies` | 插件侧的类型 / 契约声明 |
| 1b | 插件清单：客户端入口可解析（`exports["./client"].default` 在磁盘上真实存在，且能读出 `platform`） | 客户端半的入口必须可解析 |
| 1c | lockfile 不把宿主包当运行期依赖 | 锁文件是最终的安装意图 |
| 1d | 插件清单：展示元信息可解析（`exports["./locale/*.json"]` + `locale/en.json`） | 这条最容易静默失效，DSH 只会「当作没有元信息」、列表回退显示原始包名，不报任何错 |
| 2 | profile 的 `node_modules` 下没有 `@deepseek-ai` / `@standard-schema` 物理副本 | 结构性兜底，防锁文件漂移 |
| 3 | profile 副本与源码**逐字节一致**（7 个文件：`package.json`、`lib/index.js`、`lib/client.js`、`cordis.patch.yml`、`README.md`、`locale/*.json`） | `file:` 安装是**拷贝**，不是软链 |
| 4 | 从副本入口 `require.resolve.paths()` 扫不到任何宿主包候选 | 运行时解析路径必须落在宿主侧 |
| 5 | 副本入口 `lib/index.js` + `lib/client.js` 存在且均 > 1024 B | 防「假装部署成功」的空文件 |
| 6 | 首屏 CSS（`bootCss()`）与客户端 CSS（`OVERRIDE_CSS`）**逐行同源** | 不同源 ⇒ 脚本接手瞬间换样式、闪帧 |
| 7 | 首屏样式**可回收**：两个文件里的 `BOOT_MARKER` 字面量一致，宿主注入时拼上它、客户端卸载时调 `removeBootStyles()` | 不回收 ⇒ **关掉插件后外观还在**，只有刷新页面才消失；而且这条漂移**不报任何错**，静默退化 |

`bundles` 里是否包含本插件**不算失败项**。它由 `printReport()` 单独以 `!` 开头提示，
因为「没挂载」不等于「坏了」——`--check` 仍然返回成功。

只有改了 CSS 规则、想单独看同源结果时才需要额外跑一次：

```powershell
node scripts\check-css-parity.mjs           # 一致 ⇒ exit 0
node scripts\check-css-parity.mjs --dump    # 顺便打印首屏渲染出的完整 CSS
```

它同时断言两个文件里 `SIDEBAR_ALPHA` 等常量取值一致、且结果里不出现 `NaN`。

## 生效

**改动代码之后**（部署了新的 `lib/*.js`）：

```
1) 完全退出 DSH（不是关窗口、不是刷新页面）
2) 重新启动
3) 刷新 GUI，按验收清单核对
```

`dsh.profile.bundles` **只在启动时读一次**，运行中的进程不会感知；这份清单之外的东西
（也就是这个插件的全部代码）同样只在启动时模块化加载一次。客户端半的 HMR 只有在
`pnpm run dev:web` 同时运行时才免刷新，本插件不依赖它。

**已经在运行、且插件已登记**时，插件列表里的**开关是即时的**：打开当帧铺上外观
（照片紧随一次本机 `state.json` 请求），关掉当帧撤干净（含宿主写进索引页的首屏样式）。
这条不依赖任何 HMR —— 走的是 `dsh-client-modules` 的条目增删 + 插件自己的
`ctx.effect` 清理，见[架构文档](architecture.md)的「为什么必须自己摘掉宿主的首屏样式」。

## 无鉴权可达的路由探测

只要 DSH 在跑，就能用状态码判断插件加载了没（端口换成 `dsh web` 打印的那个）：

```powershell
# 插件未加载（或未重启）→ 全部 404
# 插件已加载 → 200 / 302
curl.exe -sS -o NUL -w "%{http_code}`n" http://127.0.0.1:19387/kirara-theme/state.json
curl.exe -sS -o NUL -w "%{http_code}`n" http://127.0.0.1:19387/kirara-theme/background.jpg
curl.exe -sS -o NUL -w "%{http_code}`n" http://127.0.0.1:19387/kirara-theme/background/default
```

强制立即同步 / 丢弃缓存：

```powershell
curl.exe -sS -X POST http://127.0.0.1:19387/kirara-theme/refresh
curl.exe -sS -X POST http://127.0.0.1:19387/kirara-theme/invalidate
```

`/`、`/index.html`、`/api/health` 会返回 `401`，正文是
`dsh web authentication required; reopen the URL printed by dsh web.` —— 那是 DSH 自己的会话鉴权，
不是插件的问题。鉴权是**按路由**生效的，未知路径照样返回 `404` 而不是 `401`，
所以「404 vs 200」依然是可靠的存在性信号。

但**首屏注入无法用 curl 验证** —— `__KIRARA_THEME__`、`bootCss()` 的 `<style>`、客户端 `<script>` 标签
都要在已鉴权的 GUI 里看。核对脚本见[故障排查](troubleshooting.md)。

## 服务器侧自检（不经过 DSH）

```powershell
curl.exe -sS -k -D - -o NUL --max-redirs 0 `
  'https://api.akeno6388.online:1010/api/resources/home-background'
```

预期：`302 Found` + `X-Resource-Version: <n>` + `Location: <MinIO 预签名 URL>`；
跟随 `Location` 得 `200` + `Content-Type: image/jpeg` + `ETag: "<md5>"`。

## 验收清单

没有单元测试。验证 = 部署自检 + 完全重启 + 手工核对 + **运行时开关**（E 段，不需要重启）。

### A. 部署侧（无需重启）

1. `node scripts\deploy.mjs --check` → 结尾 `✅ 不变量全部满足`，输出里有
   `✓ 首屏 CSS 与客户端 CSS 同源` 与
   `✓ 首屏样式可回收（关掉插件后外观立刻还原）`
2. profile 的 `package.json` 里，`dependencies` 有 `@kirara/dsh-plugin-kirara-theme`，
   `dsh.profile.bundles` 末尾有 `"@kirara/dsh-plugin-kirara-theme"`
3. `Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai"` → `False`

### B. 路由侧（DSH 运行中，无需重启）

4. `/kirara-theme/state.json` → 重启**前** `404`（预期，bundle 尚未加载）；重启**后** `200`
5. `/kirara-theme/background/default` → `200`，正文含 `"isDefault":true`
6. `/kirara-theme/background.jpg` → 首轮 `302`；同步完成后 `200` + `etag` 头

### C. 外观侧（完全重启 DSH + 刷新 GUI）

7. **重启后首帧不白闪**：从黑底渐变直接进入图片或渐变，没有「白 → 图」的跳变
8. 背景图**铺满**整个窗口，窗口缩放不变形、不留边
9. 半透明黑遮罩在位：`html::after` 恒为 `rgba(0,0,0,.55)`，**明暗两种主题下都不变**
   （切主题后确认：遮罩值不变，只有侧栏 / 内容区底色跟着换）
10. **左侧栏半透明**：`rgba(20,22,28,.58)`（深）/ `rgba(249,250,252,.58)`（浅），
    背景图透过侧栏可见；同时侧栏内每个面板根（`[class*="_sidebarCol"] [class*="_root"]`）的
    `backgroundColor` = `rgba(0,0,0,0)`
11. **主界面半透明**：`[class*="_centerCol"]` 深色 ≈ `rgba(16,18,24,.86)` / 浅色 ≈ `rgba(252,252,253,.86)`，
    且 `[class*="_root"][data-phase]` 的 `backgroundColor` = `rgba(0,0,0,0)` —— 否则会话主界面会被自己的不透明底
    整块盖住，照片只在侧栏看得见
11b. **右侧栏同样半透明**：Windows 下宿主原生没给 `[class*="_rightbarCol"]` 背景，靠插件补磨砂；
    否则外框透明后它会直接露出照片、正文失去衬底
11c. **侧栏右上角圆角（Windows 桌面壳）**：`border-top-right-radius` = `16px`
    （取自 `--dsh-windows-content-radius`），与内容卡左上角圆角对称
11d. **输入区底座不再有渐变**：`[class*="_composerSeat"]` 的 `backgroundColor` 必须是 `rgba(0,0,0,0)`，
    主界面从顶到底同一种透明度
11e. **侧栏底部不再有渐隐遮罩**：`[class*="_sidebarCol"] [class*="_fade"]` 的 `backgroundColor` 必须是 `rgba(0,0,0,0)`，
    账户区上方不再有一条渐变条
12. **菜单 / 弹出层 / 悬浮按钮不透明**（证明没有误改 `--dsw-specific-sidebar-fill`）。
    这一条同时是标题栏那条规则的体检：插件只覆盖顶层探针的计算后底色，没有覆盖 token 本身
13. **Windows 顶栏整条直接显示背景图**：`[class*="_frame"]:has([class*="_sidebarCol"])` 与它的 `::before` 的
    `backgroundColor` 都必须是 `rgba(0,0,0,0)`；**顶栏与下方内容区之间不应出现一条比照片更亮的横带**
    （那是宿主底色没清干净的典型症状）。顶栏**仍可拖动窗口**
13b. **右上角窗口按钮那条的底色是全透明的**：在 Console 里确认（就在本页，
    不要去找 `window.top` —— 探针就在本页，`window === window.top`）：
    ```js
    const probe = [...document.querySelectorAll('span')]
      .find(s => (s.getAttribute('style') || '').includes('dsw-specific-sidebar-fill'));
    getComputedStyle(probe).backgroundColor   // 浅色 → "rgba(255, 255, 255, 0.004)"；深色 → "rgba(0, 0, 0, 0)"
    document.querySelector('style[data-plugin-css="@kirara/dsh-plugin-kirara-theme/client.css"]')  // → 存在
    ```
    浅色的 1/255 alpha 是刻意的（宿主会把 alpha=0 的 RGB 抹掉，这样才保住「浅色兜底白」），
    实测与 0 无观感差别。观感上：三个按钮图标**直接画在顶栏（照片 + 遮罩）上**，
    没有任何色带、没有方块感。浅色 / 深色各验一次（切主题后宿主会重推一次颜色）
13c. **窗口缩放后依旧没有色带**：拖动窗口宽度改变 `cover` 裁剪，带子不应重新出现
    （置成全透明后不再依赖任何采样，缩放天然无影响）
14. 侧栏折叠 / 展开、切换页面、开关对话框均正常，无布局错位
15. DevTools 里的核对脚本全部命中（见[故障排查](troubleshooting.md)）
16. 关闭系统「透明效果」或系统要求降低透明度时，三个列的磨砂**退回不透明底**，
    主界面底部也一并回到宿主原样；标题栏那条也一起退回 `--dsw-specific-sidebar-fill` 实色

### D. 服务器同步侧

17. 启动后首次访问会触发一次后台同步；观察缓存目录出现 `background.bin` + `state.json`
18. `POST /kirara-theme/refresh` → `{ok:true,…}`
19. 服务器换图（`X-Resource-Version` 变化）后，客户端 ≤10s（首分钟内）预加载完成并**直接换图**，
    全程无淡入过渡、无整页闪烁
20. `POST /kirara-theme/invalidate` → 界面回到深色渐变（不报错、不空白）→ 下一次同步又拿回图片
21. **断网 / 服务器 404 时**：保留当前已显示的图片，界面不回退、不报错、不闪白

### E. 运行时开 / 关（无需重启、无需刷新）

这一段专门验证「插件列表里的开关是即时的」。**不要**重启 DSH，也不要刷新页面 ——
刷新会把首屏样式重新渲染一遍，反而盖住这条链路上唯一会坏的地方。

22. **关掉开关**：外观当帧整个撤掉（背景图、`.55` 遮罩、三列半透明、顶栏透明全没），
    回到宿主原本的观感。在 Console 里确认：
    ```js
    document.querySelectorAll('style[data-plugin-css="@kirara/dsh-plugin-kirara-theme/client.css"]').length  // → 0
    [...document.querySelectorAll('style')].filter(s => s.textContent.includes('kirara-theme-boot')).length   // → 0
    document.documentElement.hasAttribute('data-kirara-theme')                                                // → false
    getComputedStyle(document.documentElement, '::before').content                                            // → "none"
    getComputedStyle(document.querySelector('[class*="_sidebarCol"]')).backgroundColor                        // → 宿主原本的底色
    ```
    第三、四条是关键：**客户端 `<style>` 消失、而宿主那份首屏样式还在**时，
    `::before` 仍是 `""`、侧栏还是半透明的 —— 那就是事故五复发（见部署自检第 7 项）。
23. **再打开开关**：外观当帧回来，照片紧随一次本机 `state.json` 请求出现（≤1.5s），
    不需要刷新页面。此时首屏样式**不会**被重新注入（索引页没有重渲染），这是预期行为 ——
    客户端那份 CSS 是它的超集。
24. **反复开 / 关 3 次**：每次都干净地「有 → 无 → 有」，没有残留的半透明、
    没有叠加出多份 `<style>`、Console 也没有新增报错。

### F. 清理

25. 验收完成后关掉自己起的探测进程与后台终端
