# @kirara/dsh-plugin-kirara-theme

> 把 DeepSeek Harness 的 Web GUI 换上一套「Kirara Server App 首页」外观：
> **整屏背景图 + 半透明黑色遮罩 + 三个列（左侧栏 / 主界面 / 右侧栏）半透明 + Windows 顶栏直接露图**，
> 而这张背景图**来自 Kirara 服务器**
> （`GET /api/resources/home-background`），不是打包在插件里的静态资源。
>
> 这是 **DSH 侧**插件（宿主半 + 客户端半），**不参与 Kirara 三端（desktop / api / media）的
> 任何构建**，因此 `kirara_build` 对它不适用 —— 验收方式 = **完全重启 DSH** + 下面的手工清单。

---

## 0. 给别人用：三步装上

> 本节面向 **不是作者本机** 的用户。作者自己的开发循环（`file:` 依赖 + `scripts/deploy.mjs`）见 §2。

**第 1 步 · 添加插件。** 侧栏 **插件** → **添加插件**，填入仓库地址：

```
git+https://github.com/akeno6388/dsh-plugin-kirara-theme.git
```

也接受 `https://github.com/akeno6388/dsh-plugin-kirara-theme`（DSH 认这个形式）和本地绝对路径。
命令行等价物：`dsh plugin --profile <profile> add <spec>`。

> ⚠️ 不要用 `github:owner/repo` 简写。pnpm 会把它改写成 `git+ssh://`，没配 GitHub SSH key 的机器
> 会直接 `Host key verification failed`。用显式的 `git+https://`。
>
> ⚠️ 国内网络访问 `github.com:443` 经常超时。Gitee 镜像地址同样可用。

**第 2 步 · 启用。** 安装完成界面点 **立即启用**（或回到插件列表打开该组合包的开关）。

**第 3 步 · 决定背景图从哪来。**

- **默认**：插件的 `DEFAULT_API_BASE_URL` 指向 Kirara Server 的公开图源
  （`https://api.akeno6388.online:1010`），所以**装完即有背景图**，无需配置。
- **改成你自己的服务器**：在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

  ```yaml
  - id: kirara-theme
    config:
      enabled: true
      apiBaseUrl: 'http://192.168.1.10:1010'
      # ⚠️ 覆盖是整行替换：本文件里的 enabled 不再生效，所以要连 enabled 一起写；
      #    其余字段留空即回落到插件内置默认值。
  ```

你的服务器需要实现 `GET <apiBaseUrl><endpoint>`（默认 `/api/resources/home-background`），
返回 **302 → 图片**。插件按 302 的第一跳取版本号：版本号不变就零下载，
所以响应头里请带稳定可比的版本标识（见 §1 表格里 `syncOnce()` / `fetchFollowing()` 的说明）。

改完**完全重启 DSH**（bundles 只在启动时读一次）。

### 你还需要自己准备什么

不需要 Kirara 三端仓库，也不需要构建 —— 这是个纯外观插件。
唯一的外部依赖是**能返回背景图的服务器**（用默认图源则连这个都不用）。

### 兼容性

`peerDependencies` 声明为 `@deepseek-ai/dsh-tools@^0.2.0-rc.2`。实测语义：**适配 DSH 0.2.x 全系列**
（`0.2.0-rc.2` / `0.2.0` / `0.2.1` 都通过），`0.3.0` 起会被判 incompatible 并自动禁用。
换大版本后若仍想用，需要 `dsh plugin allow-version` 显式授权（有崩溃风险，插件本身没测过新版本）。

> ⚠️ 本插件依赖宿主 Web GUI 的**内部 class 名**（`.BynINW_sidebarCol`、`.Dc7zOa_root` 之类）。
> DSH 改版后这些名字可能变，届时外观层会静默失效（不报错），需要跟着更新插件。

### 升级

**插件暂不支持自动更新**：先在插件页卸载，再用新地址重装一次。

### 换一条分发渠道：发到 npm

上面的 git 安装是当前推荐路径（无需注册、改动即直达）。若想改成 npm 注册表安装，需要先动三处，
否则 `npm publish` 会被直接拒绝：

| # | 要改什么 | 为什么 |
|---|---|---|
| 1 | 删掉 `package.json` 的 `"private": true` | 它是 `npm publish` 的硬性拦截（**不影响 git 安装**，后者照常可用） |
| 2 | 处理 `@kirara` 作用域 | npm 上 scoped 包必须有对应 organization 才能发布；不想建就把包名改成 `dsh-plugin-kirara-theme` 之类，并同步改 profile 依赖名与 `dsh.profile.bundles` |
| 3 | 加 `"publishConfig": { "access": "public" }` | 不加的话注册表按默认可见性处理，可能发成私有 |

发布后用户可以只填包名安装：`dsh-plugin-kirara-theme` 或 `@kirara/dsh-plugin-kirara-theme@0.1.0`。
DSH 会在 npm 官方源与 npmmirror 之间自动探测（国内可省一次手动选源）。

---

## 1. 它提供什么

| 能力 | 实现位置 | 说明 |
|------|---------|------|
| 外观层（背景 + 遮罩 + 三个列半透明 + 侧栏右上角圆角 + **Windows 顶栏透明露图** + 侧栏底部渐隐遮罩去除 + 主界面底部渐变去除） | `lib/client.js` | 客户端半，注入一个 `<style>`；背景与遮罩是 `html` 的 `::before` / `::after` 伪元素，**不插入任何元素节点** |
| **侧栏透明度** | `lib/index.js` + `lib/client.js` 的 `SIDEBAR_ALPHA` | 三个列里最透明的那个；调这一个常量即可，见 §4.10 |
| **Windows 标题栏底色**（右上角最小化/最大化/关闭那条） | `lib/client.js` → `setCaptionFill()` / `createCaptionSampler()` + `OVERRIDE_CSS` 里那条探针规则 | 只改 preload 探针 span 的**计算后颜色**，再按背景图采样算出**不透明**近似色写进 `<html>`；**不覆盖设计 token**；见 §4.9 |
| 首屏防白闪 | `lib/index.js` → `bootCss()` | 宿主半，以 `kind:"style"` 行注入 `<head>`，先于客户端脚本生效 |
| 背景图服务器同步 | `lib/index.js` → `syncOnce()` | 跟随 302 → 落盘缓存 → 版本号比对 |
| 同源背景路由 | `lib/index.js` → `createRouteHandler()` | `/kirara-theme/*`，图片从本机发，前端不跨域 |
| 版本变更轮询 + 换图 | `lib/client.js` → `createPoller()` / `createPhotoLayer()` | 版本变了才离屏 `new Image()` 预解码，解码成功后才一次性换 `--kirara-theme-photo` |

**它不做的事**（刻意为之，见 §4.3 设计约束）：

- 不覆盖 `--dsw-specific-sidebar-fill` 之类的设计 token（会连带把菜单/弹出层一起变透明）
- 不用 `backdrop-filter` / 亚克力 / 模糊
- 不用 `color-mix` / `@supports` / CSS 嵌套
- **绝不写 `color`** —— 落在 `body` / `html` 上的 `!important` 颜色会被整棵树继承，
  把 harness 的文字与图标全部染成同色（§4.7 事故档案三）
- **不往 DOM 里插任何元素节点** —— 卸载 = 删 `<style>` + 摘 `<html>` 上的两个属性

### 复刻自 Kirara 的哪条链路

| Kirara_Server（WinUI 3） | 本插件（DSH 宿主半） |
|--------------------------|---------------------|
| `Services/BackgroundService.cs` | `lib/index.js` 的 `syncOnce()` / `ensureSynced()` |
| 30 分钟冷却 + 强制比对一次 ETag | `syncIntervalMinutes: 30` + equal-version 零下载 |
| `GET /api/resources/home-background`（302 预签名） | `fetchFollowing()`：手动吃第一跳拿版本号，再跟随 `Location` |
| `CacheFileName = "background_cache.enc"` | `cacheDir/background.bin` + `state.json` |
| 404 ⇒ 记日志保留旧图；异常 ⇒ 保留旧图 | 同样：失败保留当前字节，绝不把界面打回空白 |
| `DefaultBackgroundAsset` 降级默认图 | `DEFAULT_BACKDROP_CSS` 渐变（不是图片文件） |
| 换图 300ms 交叉淡入 | `swap()`：离屏 `new Image()` 预解码成功后才**一次性**换 `--kirara-theme-photo`（自定义属性无法过渡，所以不做淡入） |
| `HomeOverlay.Opacity = 0.55` | `html::after` 遮罩层恒为 `rgba(0,0,0,.55)`（浅色下也不变，见 §4.7） |
| 左侧栏半透明 | `.BynINW_sidebarCol` 铺 `rgba(20,22,28,.78)`（深）/ `rgba(249,250,252,.72)`（浅），内层 `._2H3hWW_root` 清成 `transparent`（磨砂只由列承担，见 §4.3 第 7 条） |
| 主界面 / 右侧栏半透明 | `.BynINW_centerCol` + `.BynINW_rightbarCol` 铺 `rgba(16,18,24,.86)`（深）/ `rgba(252,252,253,.86)`（浅）；内层会话根 `.Dc7zOa_root` 与输入区底座 `.Dc7zOa_composerSeat` 的**不透明实色底必须清掉**（否则整块盖住照片） |
| 圆角窗口外壳（内容卡四角内缩、露出窗口底） | 内容卡左上角本就是宿主原生的 `16px`（`--dsh-windows-content-radius`）；本插件给侧栏列补上对称的**右上角**圆角，两处缺口一起露出整屏背景 |

---

## 2. 安装（挂载到 desktop profile）

### 2.1 让 profile 依赖本插件

`C:\Users\<你>\.dsh\profiles\desktop\package.json`：

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
        "@kirara/dsh-plugin-kirara-dev",
        "@kirara/dsh-plugin-kirara-theme"   // ← 必须加在 bundles 里，否则插件不会被加载
      ]
    }
  }
}
```

> ⚠️ **`dependencies` 与 `bundles` 是两件事**：前者只负责把文件物化到 `node_modules`，
> 后者才决定「启动时加载哪些插件」。只写 `dependencies` 不写 `bundles` ⇒ 插件静默不生效。

### 2.2 声明宿主依赖（**不要安装它们**）

`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 已经写在 **`peerDependencies`**，
**绝对不要**改成 `dependencies`。理由见 §4.1 事故档案 —— 一旦 pnpm 把 `@deepseek-ai/*`
拷进 profile 的 `node_modules`，app-boot 的 `routeScoped` 会挑中 profile 本地的那份物理副本，
于是宿主里出现**两个不同的 `TOOL_RUNTIME_SCHEDULER` symbol** → `ctx.tools[SYMBOL]` 变 undefined
→ 连内置的 `read` / `pwsh` 都在 `undefined.prepare(...)` 里崩掉。

### 2.3 物化 profile 依赖树（重新部署）

```powershell
cd 'D:\works\Kirara Server Project\dsh-plugin-kirara-theme'
node scripts\deploy.mjs            # 重新 link + 部署 + 10 项不变量自检
node scripts\deploy.mjs --check    # 只自检，不动文件
node scripts\deploy.mjs --enable   # 幂等确保 bundles 里有本插件
node scripts\deploy.mjs --disable  # 幂等摘掉
```

脚本会自动找到 DSH 自带的 pnpm（`…\resources\runtime\pnpm\bin\pnpm.cjs`）——
**系统 PATH 上没有 `pnpm`**，别去 `pnpm install`。

可用环境变量覆盖：`DSH_HOME`（默认 `%USERPROFILE%\.dsh`）、`DSH_PROFILE`（默认 `desktop`）、
`DSH_PNPM`（pnpm.cjs 绝对路径）。

`--check` 的 10 项不变量（任一失败 ⇒ exit 1）：

| # | 不变量 | 为什么必须有 |
|---|--------|-------------|
| 0 | profile 的 `bundles` 里注册了本插件 | 只装不注册 = 静默无效 |
| 1 | 宿主包**不在** profile 的 `dependencies` | 见 §4.1 |
| 1-peers | 宿主包**在** `peerDependencies` | 插件侧类型/契约声明 |
| 1b | `exports["./client"].default` 在磁盘上真实存在，且能读出 `platform` | 客户端半的入口必须可解析 |
| 1c | lockfile 根节点没列宿主包 | 锁文件是最终的安装意图 |
| 2 | `node_modules` 下没有 `@deepseek-ai` / `@standard-schema` 物理副本 | 结构性兜底（防锁文件漂移） |
| 3 | profile 副本与源码**逐字节一致**（5 个文件） | `file:` 安装是**拷贝**，不是软链 |
| 4 | 从副本入口 `require.resolve.paths()` 扫不到任何宿主包候选 | 运行时解析路径必须落在宿主侧 |
| 5 | 两个入口文件存在且 > 1024 B | 防「假装部署成功」的空文件 |
| 6 | 首屏 CSS（`bootCss()`）与客户端 CSS（`OVERRIDE_CSS`）**逐行同源** | 见 §4.2；不同源 ⇒ 脚本接手瞬间换样式、闪帧 |

### 2.4 可选：调整配置

改插件的 `cordis.patch.yml`（**config 是整行替换**，必须写全量字段）：

```yaml
- insert:
    - id: kirara-theme
      name: '@kirara/dsh-plugin-kirara-theme'
      config:
        enabled: true
        apiBaseUrl: 'https://api.akeno6388.online:1010'
        endpoint: '/api/resources/home-background'
        routePath: '/kirara-theme'
        syncIntervalMinutes: 30
        requestTimeoutMs: 15000
        cacheDir: ''
```

| 键 | 默认值 | 说明 |
|----|--------|------|
| `enabled` | `true` | `false` = 挂载路由与注入样式，但**不做任何网络同步** |
| `apiBaseUrl` | `https://api.akeno6388.online:1010` | 与 Kirara 客户端 `DefaultApiBaseUrl` 同源 |
| `endpoint` | `/api/resources/home-background` | 服务器返回 302 + `X-Resource-Version` |
| `routePath` | `/kirara-theme` | 同源路由前缀，客户端半按它取图与轮询 |
| `syncIntervalMinutes` | `30` | 兜底轮询；下限被夹到 60s。客户端另有 10s/180s 的快慢轮询 |
| `requestTimeoutMs` | `15000` | 单跳超时；4.4 MB 的图走的是第二跳，也会受这个值约束 |
| `cacheDir` | `''` | 空 = 自动探测（`DSH_HOME` → `DSH_PROFILE_HOME` → `~/.dsh/kirara-theme` → 临时目录） |

> ⚠️ **config 是整行替换**：只写 `enabled` 会把其余键打回 Schema 默认值。
> 想要「只改一项」，就把这一项连同其它键一起写全。

### 2.5 生效

```
1) 完全退出 DSH（不是关窗口、不是刷新页面）
2) 重新启动
3) 在**新会话**里执行 §3 或 §3.4 的验收
```

> ⚠️ **注册新 bundle 必须完全重启 DSH**。`dsh.profile.bundles` **只在启动时读一次**，
> 运行中的进程不会感知；客户端半的 HMR 只有在 `pnpm run dev:web` 同时运行时才免刷新，
> 本插件不依赖它。

---

## 3. 开发期自检（**不用重启 DSH**）

### 3.1 `deploy.mjs --check`：先证明「部署是干净的」

```powershell
node scripts\deploy.mjs --check
```

预期结尾（10 条全绿，其中最后一条是首屏 / 客户端 CSS 同源）：

```
✅ 不变量全部满足
```

失败时它会**明确指出**是哪一条、差什么。首次部署前跑必然报「副本缺失」——那是**预期**的，
`node scripts\deploy.mjs` 之后应该全绿。

> pnpm 在部署时会打印 `[WARN] Issues with peer dependencies found.` —— **正常**，
> 因为我们刻意把宿主包声明成 peer 且不安装。

只有改了 CSS 规则、想单独看同源结果时才需要额外跑一次：

```powershell
node scripts\check-css-parity.mjs           # 一致 ⇒ exit 0
node scripts\check-css-parity.mjs --dump    # 顺便打印首屏渲染出的完整 CSS
```

### 3.2 无鉴权可达的路由探测

只要 DSH 在跑，就能用状态码判断「插件到底加载了没」：

```powershell
# 插件未加载（或未重启）→ 全部 404
# 插件已加载 → 200 / 302
curl.exe -sS -o NUL -w "%{http_code}`n" http://127.0.0.1:19387/kirara-theme/state.json
curl.exe -sS -o NUL -w "%{http_code}`n" http://127.0.0.1:19387/kirara-theme/background.jpg
curl.exe -sS -o NUL -w "%{http_code}`n" http://127.0.0.1:19387/kirara-theme/background/default
```

预期（插件已加载、尚无缓存字节）：

| 路径 | 状态 | 含义 |
|------|------|------|
| `/kirara-theme` 或 `/state.json` | `200` | 状态 JSON：`{version, hasImage, isDefault, backdrop}` |
| `/kirara-theme/background.jpg` | `302` → `/kirara-theme/background/default` | 还没有远端图 → 客户端走渐变 |
| `/kirara-theme/background/default` | `200` | `{isDefault:true, backdrop:"<渐变 CSS>"}` |
| 已同步后 `/kirara-theme/background.jpg` | `200` + `etag` + `x-kirara-theme-version` + `cache-control: public, max-age=31536000, immutable` | 版本化不可变缓存 |

强制立即同步 / 丢弃缓存：

```powershell
curl.exe -sS -X POST http://127.0.0.1:19387/kirara-theme/refresh
curl.exe -sS -X POST http://127.0.0.1:19387/kirara-theme/invalidate
```

> ⚠️ **`/`、`/index.html`、`/api/health` 会返回 `401`**（`content-type: text/plain`，
> 正文 `dsh web authentication required; reopen the URL printed by dsh web.`）。
> 这是 DSH 自己的会话鉴权，**不是插件的问题**。鉴权是**按路由**生效的 —— 未知路径照样
> 返回 `404` 而不是 `401`，所以「404 vs 200」依然是可靠的无鉴权存在性信号；
> 但**首屏注入（`__KIRARA_THEME__` / `bootCss` 的 `<style>` / 客户端 `<script>` 标签）
> 无法用 curl 验证**，必须在已鉴权的 GUI 里看。

### 3.3 服务器侧自检（不经过 DSH）

```powershell
curl.exe -sS -k -D - -o NUL --max-redirs 0 `
  'https://api.akeno6388.online:1010/api/resources/home-background'
```

预期：`302 Found` + `X-Resource-Version: <n>` + `Location: <MinIO 预签名 URL>`；
跟随 `Location` 得 `200` + `Content-Type: image/jpeg` + `ETag: "<md5>"`。

### 3.4 判断「外观层到底生效了没」—— 用**会话内可见的证据**

刷新 GUI 后，按 `F12` 打开 DevTools，逐条核对：

```js
// ① 插件全局态（宿主注入 + 客户端读回）
window.__KIRARA_THEME__
// → { routePath:"/kirara-theme", imageUrl:"/kirara-theme/background.jpg?v=...",
//     isDefault:false, version:"...", backdrop:"...", scrim:"rgba(0,0,0,.55)" }

// ② 标记属性（外观层已激活的唯一开关）
document.documentElement.getAttribute('data-kirara-theme')   // → "kirara"

// ③ 两个图层（挂在 html 的**负 z 伪元素**上，没有 DOM 节点）
getComputedStyle(document.documentElement, '::before').backgroundImage
// → url("/kirara-theme/background.jpg?v=…")（照片层；无图时是深色渐变）
getComputedStyle(document.documentElement, '::after').backgroundColor
// → rgba(0, 0, 0, 0.55)（遮罩层）

// ④ 样式表（两个 data 属性缺一不可，否则卸载时回收不掉）
document.querySelector('style[data-plugin-css="@kirara/dsh-plugin-kirara-theme/client.css"]')
// → <style data-plugin="@kirara/dsh-plugin-kirara-theme" data-plugin-css=".../client.css">

// ⑤ 首屏注入层（宿主半，在 <head> 里，先于客户端脚本）
[...document.head.querySelectorAll('style')].some(s => s.textContent.includes(':root::before'))
// → true
```

（⑤ 之所以能区分两份样式：客户端那份的规则是 `:root[data-kirara-theme]::before`，
不含连续子串 `:root::before`，所以这条断言只会命中宿主注入的首屏样式。）

再看当前生效的配色（切换 DSH 明暗主题后重跑）：

```js
// ① 左/右侧栏与内容列的磨砂值
getComputedStyle(document.querySelector('.BynINW_sidebarCol')).backgroundColor
// 深色 → rgba(20, 22, 28, 0.78)
// 浅色 → rgba(249, 250, 252, 0.72)

getComputedStyle(document.querySelector('.BynINW_centerCol')).backgroundColor
// 深色 → rgba(16, 18, 24, 0.86)
// 浅色 → rgba(252, 252, 253, 0.86)

getComputedStyle(document.querySelector('.BynINW_rightbarCol')).backgroundColor
// 深色 → rgba(16, 18, 24, 0.86) / 浅色 → rgba(252, 252, 253, 0.86)

// ② 外框透明（让整屏背景露出来）
getComputedStyle(document.querySelector('.BynINW_frame')).backgroundColor
// → rgba(0, 0, 0, 0)

// ③ 内层实色底是否已清掉（没清掉的话上面几条半透明等于白设，照片会被整块盖住）
getComputedStyle(document.querySelector('._2H3hWW_root')).backgroundColor   // → rgba(0, 0, 0, 0)
getComputedStyle(document.querySelector('.Dc7zOa_root')).backgroundColor    // → rgba(0, 0, 0, 0)

// ④ 侧栏右上角圆角（仅桌面壳生效；值就是宿主自己的 `--dsh-windows-content-radius`）
getComputedStyle(document.querySelector('.BynINW_sidebarCol')).borderTopRightRadius
// → "16px"（浅色 / 深色一样）

// ⑤ Windows 顶栏：整条顶栏透明露图（不再铺半透明遮罩；浏览器里没有 data-windows-titlebar，跳过）
getComputedStyle(document.querySelector('.BynINW_frame')).backgroundColor            // → rgba(0, 0, 0, 0)
getComputedStyle(document.querySelector('.BynINW_frame'), '::before').backgroundColor // → rgba(0, 0, 0, 0)
// 拖拽区必须还在（宿主给的，插件只清 background，没动它）
getComputedStyle(document.querySelector('.BynINW_frame'), '::before').webkitAppRegion // → "drag"
```

（这一段验的是「配色值对不对」，上面那一段验的是「外观层在不在」，两块的编号各自独立。）

---

## 4. 作者契约（逆向自 DSH 自带插件，已在 0.2.0-rc.2 实测）

### 4.1 事故档案：`Cannot read properties of undefined (reading 'prepare')`

**症状**：重启后**每一个工具调用**（包括内置 `read` / `pwsh`）都崩在
`Cannot read properties of undefined (reading 'prepare')`，DSH 会话直接不可用。

**根因**：把宿主包写进 `dependencies` ⇒ pnpm 把 `@deepseek-ai/*` 拷进
`profiles/desktop/node_modules` ⇒ app-boot 的 `routeScoped` 选中 profile 本地那份物理副本
（`kind:'native'`）⇒ 进程内出现**两个不同的 `TOOL_RUNTIME_SCHEDULER` symbol** ⇒
`ctx.tools[SYMBOL]` 读不到 ⇒ 所有派发路径在 `undefined.prepare(...)` 上炸掉。

**修复**：宿主包**只声明在 `peerDependencies`**，永不安装；并用 `deploy.mjs` 的
不变量 1 / 1c / 2 / 4 把它钉死（§2.3）。

### 4.2 事故档案二：`bootCss()` 与 `OVERRIDE_CSS` 漂移 ⇒ 首屏闪一下

首屏样式由**两处**产出、**声明体必须逐条对齐**：

- `lib/index.js` → `bootCss()`：`kind:"style"` 注入 `<head>`，**先于**客户端脚本执行 → 决定首帧
- `lib/client.js` → `OVERRIDE_CSS`：客户端挂载后注入 `<style>` → 接管后续

两处**声明体（大括号里的内容）必须完全一致**，只允许两处刻意的差异：

1. **选择器前缀不同** —— `bootCss()` 用裸 `:root`，因为此时 `data-kirara-theme` 属性**还没写上**
   （属性是客户端挂载后才设的）；`OVERRIDE_CSS` 用 `:root[data-kirara-theme]`，**正好高出
   一个属性选择器级别** ⇒ 交接后客户端那份稳定压过宿主那份，不需要比注入先后。
2. **`bootCss()` 多一条动态的 `--kirara-theme-photo: url(…)` 行**（把已有缓存图的 URL
   直接写进首帧），其余规则逐条同序、同值。

> ⚠️ 改任何一边的视觉规则，**另一边必须同步改**，否则会出现「首帧一个样、脚本跑完变另一个样」
> 的闪烁。`bootCss()` 的文档注释里已经写了这条警告，别删。

> ✅ 这条约束现在**可执行校验**：`node scripts\check-css-parity.mjs` 会直接从两份源码里取出
> 规则数组求值，把客户端前缀规范化成裸 `:root` 后逐行比对（`--dump` 还能打印首屏渲染出的完整
> CSS 供人工审阅）。改完两边跑一次，退出码 0 才算同源。

> ⚠️ `bootCss()` 那条 `photo` 规则里的 `--kirara-theme-photo` **绝不能加 `!important`**：
> 客户端换图是把新的 `url(...)` **内联写在 `<html>` 的 `style` 上**（`setProperty`），
> 内联声明本就该压过作者样式表；一旦宿主那边写了 `!important`，客户端就再也换不动图了。

**关于「淡入」**：这条链路**没有淡入**。自定义属性（custom property）的取值是**离散**的，
不能 transition —— 两边都是先用 `new Image()` 预加载 + 解码，解码完成才直接把属性换成新值。
客户端独占这一步，宿主那份只负责首帧的 URL，所以**不会闪两次**。

### 4.3 外观 CSS 的九条硬约束（**改之前先读**）

写在 `lib/client.js` 的 `OVERRIDE_CSS` 注释块里（注释块是 9 条；注释第 4 条「绝不写 `color`」在
下面 §4.7 单独展开，所以这里按剩余顺序编号为八条，即**本文第 N 条 = 注释第 N 条（N≤3）、
本文第 4~8 条 = 注释第 5~9 条**），复述一遍：

1. **不覆盖 `--dsw-specific-sidebar-fill`**。该 token 同时被菜单、弹出层、
   `--dsw-alias-button-elevated-fill` 系列复用 —— 改它会让**所有浮层一起变半透明**。
   正确做法：只给**三个列元素**（`.BynINW_sidebarCol` / `.BynINW_centerCol` / `.BynINW_rightbarCol`）
   铺半透明底，并把内层容器原来的不透明底清成 `transparent`（见本文第 7 条 = 注释第 8 条）。
2. **不用 `backdrop-filter`**。Kirara 首页没有任何亚克力/模糊（整屏照片已经盖住窗口级 Mica）。
3. **不用 `color-mix` / `@supports`**。统一写死 `rgba()`，宿主注入的首帧 CSS 与客户端
   才能逐字节对齐，也避开旧 Chromium 的解析差异。
   ⚠️「写死」= 写**算式**：透明度经 `SIDEBAR_ALPHA` 常量参与拼接（§4.10），
   两个文件里必须同名同值；拼接结果会取整到三位小数，避免
   `1 - 0.42 = 0.5800000000000001` 这种浮点毛刺破坏逐字节一致。
4. **主题只认 `body[data-ds-dark-theme]`**（属性存在 = 深色，不存在 = 浅色）。
   这是 DSH 唯一可信的主题真值 —— **没有** `data-ds-light-theme`，也**没有** `data-color-scheme`。
5. **客户端每条选择器都带 `:root[data-kirara-theme]` 前缀**，特异度 (0,2,0) 稳定压过布局层的
   (0,1,0)，与注入先后无关。**深色分支追加一个后代后缀** ` body[data-ds-dark-theme]`
   （因为主题属性挂在 `<body>` 上），写成
   `:root[data-kirara-theme] body[data-ds-dark-theme]`。
   ⚠️ **不能**写成 `:root[data-kirara-theme][data-ds-dark-theme]` —— 那是「同一个元素同时带两个
   属性」，`<html>` 上永远没有 `data-ds-dark-theme` ⇒ 深色规则**永不命中**；
   **也不能**写成 `body[data-ds-dark-theme] :root[…]` —— 那是个错误的后代选择器。
   宿主半（`bootCss()`）用裸 `:root` 前缀，深色分支即 `:root body[data-ds-dark-theme]`。
6. **列与内层类名全是构建期哈希**（`.BynINW_sidebarCol` / `.BynINW_centerCol` /
   `.BynINW_rightbarCol` / `._2H3hWW_root` / `.Dc7zOa_root` / `.Dc7zOa_composerSeat`）。这些元素上
   **没有任何稳定属性**可依赖，只能写死哈希。DSH 升级导致哈希变化时，后果是
   「**该处不再半透明 / 圆角消失**」—— 布局不会被破坏，属于可接受的降级。
   （哈希值在 0.2.0-rc.2 实测有效；核对方式：从 `resources/app.asar` 里解出
   `@deepseek-ai/dsh-client-ui-layout|sidebar|conversation/lib/client.js` 搜类名。）
7. **磨砂只能由「列」承担，内层实色底必须清成 `transparent`**。宿主在两处内层根上
   各自铺了**不透明**底：侧栏 `._2H3hWW_root{background:var(--dsw-specific-sidebar-fill)}`、
   会话主界面 `.Dc7zOa_root{background:var(--dsw-alias-bg-base)}`，还有一条把输入区底部
   收口到实色的 `.Dc7zOa_composerSeat` 渐变。只改列的颜色而不管内层，后果有两个方向：
   - 内层不动 ⇒ 实色把照片**整块盖住**（现象：侧栏半透明看得见背景，主界面却是纯色面板）；
   - 内层也铺同色半透明 ⇒ 两层叠加反而**推回近实心**（`0.72` 叠 `0.72` ≈ `0.92`）。

   所以准确的配方是：**透明度只在列上设一次，内层一律 `transparent`**。
   （宿主自己在 darwin 下就是这么分层的 —— `[data-platform=darwin] ._2H3hWW_root{background:0 0}`。）
8. **Windows 顶栏是「零透明度」的唯一例外**：顶栏那条**不设任何透明度**，直接
   `transparent` 露出背景图层。宿主在顶栏上有**两层**不透明来源，必须一起清：
   `.BynINW_frame`（给 `padding-top` 预留的顶栏高度填的 `--dsw-specific-sidebar-fill`）
   与 `.BynINW_frame:before`（`height:var(--dsh-windows-titlebar-height)` 的全宽拖拽条，
   自己又铺了一层同色底 —— 这就是「顶栏被半透明遮罩盖住」的观感来源）。
   只清 `:before` 会剩外框一层，只清外框会剩 `:before` 一层，**症状都是顶栏比下方内容区更亮**。
   ⚠️ 只清 `background`，**保留 `:before` 的 `-webkit-app-region:drag`**（窗口拖拽几何，宿主给的）。
   ⚠️ 这条规则的特异度是 (0,3,0)（比通用列规则多一个 `[data-windows-titlebar]`），
   高于宿主外框那条 (0,2,0) —— 所以**显式把 `.BynINW_frame` 写进选择器列表**，
   不靠「作者样式表内后者胜」这种顺序依赖（不写的话要靠早前那条 (0,2,0) 的外框规则兜底，
   打平即依赖顺序）。
   对照第 1 条：这里清的是**具体元素**上的声明，**没有**去覆盖 `--dsw-specific-sidebar-fill`
   这个 token 本身 —— 菜单与浮层不受影响。

### 4.4 客户端半的模块契约

DSH 的客户端插件是**经典脚本**（不是 ESM），格式固定：

```js
window.__ModuleLoader__.load({
  id: "@kirara/dsh-plugin-kirara-theme",   // 必须 === package.json 的 name
  factory: (require) => { var module = { exports: {} }; /* … */ return module.exports; }
});
```

- **有且只有一次** `load()` 调用；**不能**出现 `import` / `export`
- 依赖只能走 `require` 参数，且名字必须在白名单内（本插件**一个都没用**，
  所以 `dsh.client.external` 为空）
- 导出对象 = cordis 插件 `{ name, apply(ctx) }`
- 副作用统一放进 `ctx.effect(fn, "label")`，`fn` 返回清理函数
- 自建 `<style>` 必须同时带 `data-plugin` 与 `data-plugin-css` 两个属性，
  否则 `dsh-client-modules` 卸载时**回收不掉**这个 `<style>`
- 定时器用原始 `setTimeout` / `setInterval` + `timer.unref()`
  （`ctx.setTimeout` / `ctx.setInterval` 已是废弃别名）

### 4.5 为什么必须写 CSS/DOM，而不是挂 slot

Web shell **只注册了 `root` 一个 slot**，`#root` 里只有 AppFrame。也就是说：

- **纯 slot 挂载无法把图层放到最底层** —— 没有比 AppFrame 更低的位子
- `shell.leading` 只在 macOS 且侧栏折叠时才挂载 ⇒ **Windows / Web 上不可用**

所以外观层只能是两种手段的组合：

1. `document.head` 注入一个自建 `<style>`（承载全部外观规则）
2. 在 `<html>` 上使用**负层级伪元素**做图层：`html::before` 放背景图，
   `html::after` 放半透明黑遮罩，两者都 `position:fixed; inset:0;
   z-index:-1; pointer-events:none`

**为什么必须是「`html` 的负 z 伪元素」**——按 CSS 2.1 附录 E 的绘制顺序，根堆叠
上下文里的顺序是：

```
html 背景/边框 → 负 z 的子堆叠上下文（html::before / html::after）→
文档流内非定位后代（**body 的背景**）→ 行内内容 → z-index>=0 的定位元素
```

由此得到两条硬结论：

- **`body` 必须透明**（`body { background-color: transparent !important }`）：
  否则 body 自己的背景色会画在负 z 伪元素**之上**，把背景图整块挡住
- 给 `html` 设 `background-color` 是**无效果的**（它本就是最底一层，不解决问题）

> ⚠️ **绝不要用 DOM 节点做图层**：任何 `position:fixed` 且 `z-index>=0` 的节点
> （包括一个 append 到 `<body>` 末尾的 `<div>`）都会画在**整个应用之上**，
> 表现为「界面只剩背景图、文字和侧栏全都不见了」。唯一安全的位置就是
> `html` 上的负 z 伪元素。
>
> 两个伪元素同为 `z-index:-1`，因此按**树序**决定上下：`::after`（遮罩）在
> `::before`（背景图）之后，所以遮罩稳定盖在图片上。

### 4.6 卸载与回滚是纯结构性的

卸载时按**逆序**执行清理（每步单独 try/catch）：

```
clearInterval / clearTimeout → 摘 visibilitychange 监听
→ photoLayer.dispose()（置 disposed、清 pending、removeProperty("--kirara-theme-photo")）
→ document.documentElement.removeAttribute("data-kirara-theme")
→ 按 data-plugin-css 移除自建 <style>
```

**唯一的「内联写入」只有一处**：往 `<html>` 写自定义属性 `--kirara-theme-photo`。
所以回滚只需要一次 `removeProperty`，而不是「逐条还原」。除此之外插件没有改写
任何既有元素的 `style`，也没有 append 任何 DOM 节点 —— 这是刻意的设计，
别改成往页面里塞图层节点。

### 4.7 事故档案三：不要给 body 写 `color`

早期版本为了统一文字颜色，在 `body` 上写了：

```css
color: var(--dsw-alias-text-primary, #f5f6f8) !important;   /* ❌ 已删除，禁止恢复 */
```

后果是**整个界面文字、图标全部消失**（只剩背景图，只有「应用 / 编辑」两个按钮可见）。

根因有两层：

1. **`--dsw-alias-text-primary` 这个 token 根本不存在**。真实 token 是
   `--dsw-alias-label-primary`（可在 `theme-client.js` 里核对）。自定义属性
   取不到值时回退到字面量 `#f5f6f8`，于是**近白色永远生效**
2. 该声明带 `!important` 且落在 `body` 上，**继承会污染全树**：所有没自己指定
   `color` 的文本、图标都变成近白色 —— 浅色主题下等于白底白字

修复：**两个半的 CSS 里删除了全部 `color` 声明**，现在只剩 `background-color:`。

> ⚠️ **教训**：任何写在 `html` / `body` 上的 `color …!important` 都会劫持整个
> 应用的继承色。要引用 DSH 主题 token 之前，**必须先去 `theme-client.js` 里
> 确认这个 `--dsw-*` token 真的存在**；拿不准就不要碰颜色。

### 4.8 事故档案四：不要用 append 的 div 当图层

更早的版本把背景板做成两个 append 到 `<body>` 的元素：

```
#kirara-theme-backdrop  { position: fixed; inset: 0; z-index: 0; }
#kirara-theme-scrim     { position: fixed; inset: 0; z-index: 1; }
```

后果：**AppFrame 被整个盖住** —— 文字与侧栏不可见，底部还多出一条渐变遮罩。

根因见 §4.5 的绘制顺序：`z-index:0` 已经是「`z-index>=0` 的定位元素」那一档，
AppFrame 在文档流里是 `z-index:auto`，因此 0/1 不是「在其下」而是**在其上**。

修复：改成 `html` 上的负 z 伪元素 + `body` 透明，页面里**不再有任何插件 DOM 节点**。

> ⚠️ **铁律（背下来）**：
> 负 z 子堆叠上下文 < `body` 背景 < 文档流内内容 < **任何 `z-index>=0` 的 fixed 节点**。

### 4.9 Windows 标题栏底色：唯一入口是 preload 的**探针 span**（★ 就在本页）

右上角最小化/最大化/关闭那条底栏**不是 DOM**，是 Windows 合成器画的（Electron
`titleBarOverlay` → 主进程 `setTitleBarOverlay()`）。链路如下（0.2.0-rc.2 + Electron 24.18.1 + Win11 实测）：

```
preload（在**本页**运行 —— 实测 window === window.top）
  ├─ 建一个隐藏探针 span：background-color:var(--dsw-specific-sidebar-fill)
  ├─ 用 canvas 把它读成 rgba(...)（nativeColor()）
  └─ ipcRenderer.send('dsh-desktop:windows-appearance', lang, color, symbolColor)
        ↓（主进程校验：senderFrame.url 必须以 dsh-app://app/ 开头）
     mainWindow.setTitleBarOverlay({ color, symbolColor })
```

**四条实测结论（踩过的坑，别再试）**：

1. **探针就在本页**：实测 `window === window.top`、`window.top.document === document`，
   `document.querySelector('span[style*="--dsw-specific-sidebar-fill"]')` 直接命中
   （`probeBg = rgb(27, 27, 28)`，即深色下 `--dsw-specific-sidebar-fill` 的值）。
   ⇒ 规则写进 `OVERRIDE_CSS` / `bootCss()` **即可生效**，不需要任何跨文档注入。
   > ⚠️ **曾经判断错**：早期一条 `isTop:false` 的探测被误读成「GUI 跑在 iframe 里」，
   > 于是实现了「往 `window.top.document.head` 注入独立样式表」，并用
   > `if (window.top === window) return null` 做守卫 —— 在当前结构下那个守卫**必然命中**，
   > 整条链路静默失效（症状：右上角**永远不变**，且没有任何报错）。
   > **别再引入跨文档注入/`window.top` 守卫**；判据见 §6 第 13b 条。
2. **标题栏不吃任何透明值 —— 连显式 `transparent` 都不行（★ 别再试第 4 次）**：
   三次实测把「真透明」彻底排除：
   | 推过去的值 | 结果 |
   |---|---|
   | `rgba(0, 0, 0, 0.55)` | **界面毫无变化**（被忽略，不是被压成透明） |
   | `transparent`（探针 computed 直接设成透明） | **界面毫无变化** |
   | `rgb(255, 0, 170)`（不透明） | **立刻变色** |
   ⇒ 结论：`titleBarOverlay` 只接受**不透明**颜色；`transparent` / 带 alpha 的值会被
   Electron 或 DWM 当作**无效值直接忽略**（标题栏保持上一次的颜色，而不是变透明）。
   所以「直接设成透明」不是没试过，而是**物理上不可行** —— 采样近似色是唯一手段。
3. **`dshDesktop` 上没有任何相关方法**（实测只有 `protocolVersion / browser / deviceInfo /
   keyboard / shortcuts / updates / hasApiKey / setActive / ready / failed / open /
   setBounds / close`），**monkey-patch `ipcRenderer.send` 也不是可行方案**（preload 的
   `require` 在隔离世界，插件拿不到那个对象）。⇒ 探针的 computed 底色是**唯一**入口。

**本插件的做法**：

- `OVERRIDE_CSS` / `bootCss()` 里一条普通规则，把探针的 `background-color` 指到 CSS 变量
  `--kirara-caption-fill`（**只改这个探针元素的声明，不覆盖 `--dsw-specific-sidebar-fill`
  本身**，所以菜单与浮层照旧不透明）；
- 该变量由 `createCaptionSampler()` 算出、经 `setCaptionFill()` 写在**本页 `<html>`** 的
  行内样式上：重做 `background-size:cover` + `center` 的缩放与居中裁剪，
  在「距右边缘 60px、纵向 4px」处取一块 **160×28 屏幕像素**的平均色 ——
  **不是单像素**：单点取样会让整条带子偏成那一个像素的色调，看上去就是「一块填充」；
- 再把平均色按下面的公式换算成**不透明**色。

**★ 取色公式（写反了症状就是「右上角仍是一条更深的实色带」）**：

```
标题栏 = 操作系统画在**网页之上**的一层（Electron titleBarOverlay / DWM）
       ⇒ 没有任何东西会再压在它上面，它的观感 **就是** 我们推过去的颜色 X

它底下露出的顶栏 = 照片 + `html::after` 遮罩 = (1-a)·photo + a·scrim

要让两者一致 ⇒  X = (1-a)·photo + a·scrim     ← 只合成一次（与 html::after 同款）
```

> ⚠️ **不要把 X 写成「反解」** `(photo - a·scrim)/(1-a)`。它基于一个**错误前提**
> （「浏览器会把遮罩再压到标题栏上」）—— 标题栏在网页之上，遮罩压不到它；反解会让标题栏
> 比顶栏**更亮**。推导已固化在 `lib/client.js` 的 `captionColorFor()` 注释里，别再改回去。

- 换图、窗口 resize（防抖 200ms）都会重采；`canvas` 被污染 / 解码失败时**静默放弃**，
  规则回落到 `rgba(0,0,0,.55)` —— 不报错、不留半个状态；
- 卸载时 `captionSampler.dispose()` + `setCaptionFill("")` 摘掉变量；
  `<style>` 由统一的那条 `CSS_ID` 回收逻辑处理。

> ⚠️ **不允许**为了这条链路去改 `resources/app.asar` 里的 `lib/main.js` / `lib/preload-app.cjs`：
> 那是 DSH 安装目录、会被升级覆盖，改它等于破解宿主。
>
> ⚠️ 像素级完美不可能：标题栏是**整条窗口宽一个颜色**，而它下面的照片横向有变化 ——
> 取小块平均色能让「按钮簇附近」最贴合，离得越远越可能看出轻微色差（README §7 已记）。

### 4.10 侧栏透明度：改一个常量，但要小心「越大越透」

三个列的半透明底里，**侧栏是最透的**（内容列 / 右侧栏固定在 `.86`）：

| 列 | 实心度 | 对应常量 |
|---|---|---|
| `.BynINW_sidebarCol` | **`.58`** | `SIDEBAR_ALPHA = 0.42`（⇐ 本节的旋钮） |
| `.BynINW_centerCol` / `.BynINW_rightbarCol` | `.86` | 写死在规则里 |

**★ 命名语义：`SIDEBAR_ALPHA` 是「透明度」，不是「不透明度」。**

```
写进 CSS 的实心度 = 1 - SIDEBAR_ALPHA       ⇒ rgba(249,250,252, 0.58)
```

所以**数字越大 = 越透明**。这是刻意反着命名的 —— 若叫 `SIDEBAR_OPACITY`，
想「更透」的人会顺手把值从 `.72` 改到 `.85`，结果**更实心**，然后困惑为什么没效果。
（本插件最早的两版值就是手写的 `rgba(...,.72)` / `rgba(...,.78)`，正是这种混淆的温床。）

改它需要**同时**改两个文件里同名同值的常量（`lib/index.js` 与 `lib/client.js`），
否则首屏 CSS 与客户端 CSS 会漂移（§4.2）。改完必须跑：

```bash
node scripts/check-css-parity.mjs      # 会额外断言这两个文件的常量取值一致
```

**取值参考与代价**（都以 `.55` 黑遮罩参与合成为前提）：

| `SIDEBAR_ALPHA` | 实心度 | 观感 | 代价 |
|---|---|---|---|
| `0.28` | `.72` | 原来的默认值，几乎看不出照片 | 面板感最强 |
| **`0.42`** | **`.58`** | **当前值**：照片明显透出，正文仍然清晰 | —— |
| `0.58` | `.42` | 侧栏明显融进背景 | 浅色主题下正文开始需要背景配合 |
| `0.72` | `.28` | 接近「一层薄雾」 | 正文可读性依赖背景图明暗 |

> ⚠️ **两个必须连带的注意事项**：
> 1. 同一条规则还出现在**无障碍媒体查询**里（`prefers-reduced-transparency:reduce`）——
>    那里回落到宿主的 `var(--dsw-specific-sidebar-fill)`，**与透明度无关，不用改**；
> 2. **别顺手去调 `--dsw-specific-sidebar-fill`**（见 §4.3 约束 1）：那个 token 同时被菜单与
>    所有浮层复用，改它会让浮层一起变半透明。本插件的做法始终是「只给列元素铺半透明底」。

---

## 5. 目录结构

```
dsh-plugin-kirara-theme/
├── package.json          # 包契约：type/main/exports/files/dsh.client + dsh.bundle.patch
├── cordis.patch.yml      # bundle patch（顶层 YAML **数组**，config 整行替换）
├── README.md             # 本文件
├── lib/
│   ├── index.js          # 宿主半：Config / 路由 / 同步 / 磁盘缓存 / bootCss / bootGlobal
│   │                     #   SIDEBAR_ALPHA 等三个常量（侧栏透明度旋钮，见 §4.10）
│   └── client.js         # 客户端半：外观 CSS / 背景图层 / 轮询 / 换图（预加载后直换，无淡入）/
│                         #   Windows 标题栏近似色（探针规则 + 采样，见 §4.9）/
│                         #   同名同值的 SIDEBAR_ALPHA 三常量（§4.10）/ 清理
└── scripts/
    ├── deploy.mjs             # link + 部署 + 10 项不变量自检（--check / --enable / --disable）
    └── check-css-parity.mjs   # 首屏 bootCss() 与客户端 OVERRIDE_CSS 的「逐条同源」断言（--dump 打印渲染结果）
                              #   + 断言两侧 SIDEBAR_ALPHA 等常量取值一致、且结果里不出现 NaN
                              #   ↑ 同时被 deploy.mjs 作为第 6 条不变量复用（可单独跑）
```

`package.json` 里的关键字段：

```jsonc
{
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":                  { "default": "./lib/index.js" },
    "./client":           { "default": "./lib/client.js" },   // ← 必须写成 { default: … } 对象形式
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json":     "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": [], "immediately": true }
  },
  "peerDependencies": {                      // ← 永不安装，见 §4.1
    "@deepseek-ai/dsh-tools": "^0.2.0-rc.2",
    "@deepseek-ai/schemastery": "~3.18.4"
  }
}
```

`dsh.client` 的合法字段**只有** `platform`（必填）/ `inject` / `external` / `immediately`。

---

## 6. 验收清单（无单元测试；**构建 = 部署自检 + 完全重启 + 手工核对**）

### A. 部署侧（无需重启）

1. `node scripts\deploy.mjs --check` → 结尾 `✅ 不变量全部满足`，且输出里有
   `✓ 首屏 CSS 与客户端 CSS 同源`（第 6 条不变量；单独跑：`node scripts\check-css-parity.mjs`，
   加 `--dump` 可打印渲染出的首屏 CSS）
2. `Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json"` →
   `dependencies` 里有 `@kirara/dsh-plugin-kirara-theme`，
   `dsh.profile.bundles` 末尾有 `"@kirara/dsh-plugin-kirara-theme"`
3. `Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai"` → `False`

### B. 路由侧（DSH 运行中，无需重启）

4. `curl.exe -sS -o NUL -w "%{http_code}" http://127.0.0.1:19387/kirara-theme/state.json`
   → 重启**前** `404`（预期，bundle 尚未加载）；重启**后** `200`
5. `…/kirara-theme/background/default` → `200`，正文含 `"isDefault":true`
6. `…/kirara-theme/background.jpg` → 首轮 `302`；同步完成后 `200` + `etag` 头

### C. 外观侧（完全重启 DSH + 刷新 GUI）

7. **重启后首帧不白闪**：从黑底渐变直接进入图片/渐变，没有「白 → 图」的跳变
8. 背景图**铺满**整个窗口（`background-size:cover`），窗口缩放不变形、不留边
9. 半透明黑色遮罩在位：`html::after` 恒为 `rgba(0,0,0,.55)`——**明暗两种主题下都不变**
   （切 DSH 明暗主题后确认：遮罩值不变，只有侧栏/内容区底色跟着换）
10. **左侧栏半透明**：深色 `rgba(20,22,28,.78)` / 浅色 `rgba(249,250,252,.72)`，
    背景图透过侧栏可见；同时 `_2H3hWW_root` 的 `backgroundColor` = `rgba(0,0,0,0)`
    （内层没清掉的话实际观感会偏实心）
11. **主界面（内容区）半透明**：`.BynINW_centerCol` 浅色 ≈ `rgba(252,252,253,.86)` /
    深色 ≈ `rgba(16,18,24,.86)`，且 `Dc7zOa_root` 的 `backgroundColor` = `rgba(0,0,0,0)`
    —— 否则会话主界面会被自己的不透明底整块盖住，照片只在侧栏看得见。
    0.86 是刻意挑的阈值，再低正文可读性就受影响（黑色遮罩再兜一层对比度）
11b. **右侧栏同样半透明**：Windows 下宿主原生没给 `.BynINW_rightbarCol` 背景，
    靠插件补磨砂；否则外框透明后它会直接露出照片、正文失去衬底
11c. **侧栏右上角圆角（Windows 桌面壳）**：`.BynINW_sidebarCol` 的
    `border-top-right-radius` = `16px`（取自 `--dsh-windows-content-radius`），
    与内容卡左上角圆角对称；圆角缺口里看到的是整屏背景（不是另一块纯色）
11d. **输入区底座不再有渐变**：会话底部 `.Dc7zOa_composerSeat` 的**渐变已删除**，
     `backgroundColor` 必须是 `rgba(0, 0, 0, 0)`；主界面从顶到底同一种透明度，
     **不再出现「越往下越实」的渐隐带**（对照：旧行为是一条 36px 的
     `linear-gradient(… transparent 0px, … .86 36px)`）
11e. **侧栏底部（账户区上方）不再有渐隐遮罩**：会话列表底部的 `._9lTDKa_fade`
     （24px，`linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill))`）
     的 `backgroundColor` 必须是 `rgba(0, 0, 0, 0)` —— 侧栏从上到下是同一种半透明，
     账户区上方不再有一条渐变条
12. **菜单 / 弹出层 / 悬浮按钮不透明**（证明没有误改
    `--dsw-specific-sidebar-fill`，见 §4.3 第 1 条）。
    ⚠️ 这一条同时是**标题栏那条规则的体检**：插件只覆盖顶层探针的 computed 底色，
    **没有**覆盖 token 本身，所以菜单照旧不透明；若菜单变透明了，说明实现走偏了
13. **Windows 顶栏整条直接显示背景图**：顶栏（窗口顶端预留的标题栏高度，全宽 —— 含中央与右侧，
    以及内容卡左上角 16px 圆角缺口）**没有任何半透明遮罩**，看到的就是整屏照片本身，
    与左右栏上方同一张图、同一对比度（对比度由 `html::after` 的 `rgba(0,0,0,.55)` 统一承担）。
    对照 §3.4 第 ⑤ 段断言：`.BynINW_frame` 与 `.BynINW_frame::before` 的 `backgroundColor`
    都必须是 `rgba(0, 0, 0, 0)`；**顶栏与下方内容区之间不应出现一条比照片更亮的横带**
    （那是宿主 `--dsw-specific-sidebar-fill` 底色没清干净的典型症状）。
    顶栏**仍可拖动窗口**（`:before` 的 `-webkit-app-region:drag` 原样保留）；
13b. **右上角窗口按钮那条不再是一块「另外的颜色」**（§4.9）：
     在 Console 里确认（**就在本页**，不要去找 `window.top` —— 探针就在本页、`window === window.top`）：
     ```js
     const probe = [...document.querySelectorAll('span')].find(s => (s.getAttribute('style')||'').includes('dsw-specific-sidebar-fill'));
     getComputedStyle(document.documentElement).getPropertyValue('--kirara-caption-fill')  // → "rgb(r, g, b)"（不透明、采样值）
     getComputedStyle(probe).backgroundColor                                                // → 同上（不再是 rgb(27, 27, 28)）
     document.querySelector('style[data-plugin-css="@kirara/dsh-plugin-kirara-theme/client.css"]')  // → 存在
     ```
     观感上：**标题栏与它正下方的顶栏看不出接缝**（同一张照片、同一层 .55 黑遮罩的合成色）。
     采样失败时（canvas 被污染 / 解码失败）允许回落到 `rgba(0,0,0,.55)` —— 此时会略有色差，但不会报错；
13c. **窗口缩放后接缝依旧**：拖动窗口宽度（改变 `cover` 裁剪）后约 200ms，
     `--kirara-caption-fill` 应重新算出一个新值，按钮附近仍看不出接缝；
14. 侧栏折叠 / 展开、切换页面、开关对话框均正常，无布局错位
15. DevTools 里 §3.4 两段断言全部命中（第一段 5 条「外观层在不在」，
    第二段 7 条「配色值对不对」）
16. 关闭「透明效果」/ 系统要求降低透明度时（`prefers-reduced-transparency: reduce`），
    三个列的磨砂**退回不透明底**（侧栏 `--dsw-specific-sidebar-fill`、主区 `--dsw-alias-bg-base`），
    主界面底部也一并回到宿主原样 —— 不影响可读性（内层 `transparent` 保持不变，
    因为颜色层已实心）。⚠️ 标题栏此时由 `OVERRIDE_CSS` 里那条探针规则的同款媒体查询接管，
    回到宿主原本的 `--dsw-specific-sidebar-fill` 实色（与宿主自己的回退同一时机）

### D. 服务器同步侧

17. 启动后首次访问会触发一次后台同步；观察缓存目录出现 `background.bin` + `state.json`
18. `curl.exe -sS -X POST http://127.0.0.1:19387/kirara-theme/refresh` → `{ok:true,…}`
19. 服务器换图（`X-Resource-Version` 变化）后，客户端 ≤10s（首分钟内）预加载完成并**直接换图**，
    全程无淡入过渡、无整页闪烁
20. `curl.exe -sS -X POST http://127.0.0.1:19387/kirara-theme/invalidate`
    → 界面回到深色渐变（不报错、不空白）→ 下一次同步又拿回图片
21. **断网/服务器 404 时**：保留当前已显示的图片，界面不回退、不报错、不闪白

### E. 清理

22. 验收完成后关掉自己起的探测进程 / 后台终端

---

## 7. 已知限制与取舍

| 限制 | 影响 | 为什么接受 |
|------|------|-----------|
| 列与内层类名都是构建期哈希（六个类） | DSH 升级后侧栏/主界面可能不再半透明，或圆角消失 | 这些元素没有稳定属性可依赖；降级后果仅是「该处不透明 / 圆角消失」，布局不坏（§4.3 第 6 条） |
| 滑砂只由「列」承担，内层实色一律被清成 transparent | 宿主以后新增的、以不透明 `bg-base` 铺满主区的面板（如定任务 `S0jZwq_page`）仍会是纯色面板 | 逐个面板改颜色会持续跑在哈希类名上；已清的三个（侧栏根 / 会话根 / 输入区底座）是当前唯一遮挡整屏照片的层 |
| 侧栏只补了右上角圆角 | 侧栏的左侧两角仍是直角（与窗口边缘平齐） | 视觉上只需与内容卡左上角圆角呼应；其余三角贴窗口边，圆角反而会出现不合缝的空隙 |
| `:root[data-windows-titlebar]` 选择器 | 普通浏览器页面里不生效（圆角与顶栏透明都不生效） | 该属性由桌面壳设置；浏览器里本来也没有原生拖拽条（此时顶栏那条根本不存在） |
| 顶栏透明靠「清具体元素」而非改 token | DSH 若换掉顶栏那两层（改类名 / 改由别的元素铺底），顶栏会又出现一条比照片更亮的横带 | 改 `--dsw-specific-sidebar-fill` 会连带把菜单与浮层一起变透明（§4.3 第 1 条）；症状可自检（§3.4 第 ⑤ 段），降级不破坏布局 |
| 顶栏透明后顶栏上的固定控件（侧栏折叠 / 新建会话）直接压在照片上 | 对比度只由 `.55` 黑遮罩兜底 | 与 Kirara 首页语义一致；控件自身有主题色底板，实测可辨 |
| **标题栏（窗口按钮条）只能是「不透明近似色」** | 标题栏是整条窗口宽一个颜色，而下面的照片横向有变化 ⇒ 采样处（右侧 160×28 块的平均色）附近最贴合，远处可能看出轻微色差；照片横向变化剧烈时更明显 | **真透明物理上不可行**：实测带 alpha 的 `rgba` 与显式 `transparent` 推过去标题栏都**毫无变化**，只有不透明色生效（三次实测见 §4.9 结论 2）。故取小块平均色 + 公式「合成一次」是当前能把接缝压到最小的组合 |
| 标题栏近似色依赖 preload 探针仍在页面里 | 若 DSH 以后不再建那个探针 span（或改了它的行内 style 文本），规则匹配不到 ⇒ 标题栏回到宿主自己推的颜色 | 匹配用的是 `span[style*="--dsw-specific-sidebar-fill"]`（探针唯一特征），失败只是「维持原样」，不报错；判据见 §6 第 13b 条 |
| 探针规则的**发射顺序**必须与宿主 bootCss() 逐行一致 | 顺序不同 ⇒ `check-css-parity` 失败（部署自检第 10 项） | 这是 §4.2 反漂移契约的一部分；改规则位置时两个文件要一起改 |
| 顶栏去掉遮罩后，顶栏上的窗口按钮文字对比度只由 `.55` 黑遮罩承担 | 极亮背景图上按钮图标可能偏淡 | 与 GUI 其余部分同一层遮罩，视觉一致优先 |
| 首屏注入的 CSS 拿不到「尚未读盘完成」的图 | 极冷的首帧是渐变，随后淡入图片 | `restoreFromDisk()` 还在 await 时 `bootCss()` 已同步执行；客户端 `boot.imageUrl` 会紧接着补上，无需修 |
| 缓存目录默认位置靠探测 | 未设 `DSH_HOME` 时落到 `~/.dsh/kirara-theme` | DSH 没有 `plugin-data` 约定，只能逐级兜底 |
| `?v=<version>` 与 `immutable` 头并用 | 略微冗余 | 版本化 URL 语义更清晰，且保证版本切换时 URL 唯一 |
| 未做鉴权 | `/kirara-theme/*` 无鉴权即可读 | 它是**同源本机**资源路由，且背景图本身就是公开资源；但**绝不**用它代理任何敏感内容 |

---

## 8. 与「三端项目画像」的同步

本插件属于 **DSH 工具链**，与 Kirara 三端（`desktop` / `api` / `media`）**没有任何构建关系**：

- ❌ **不要**用 `kirara_build` 验证它（那个工具只覆盖 desktop / api / media 三个子项目）
- ✅ 验证方式 = `node scripts\deploy.mjs --check`（部署契约）+ **完全重启 DSH** + §6 的手工清单
- ✅ 需要读 Kirara 侧参考实现时用 `kirara_docs`（背景链路的原型是
  `Services/BackgroundService.cs`），**不要**把 DSH 插件的代码写进 Kirara 三端仓库

> 同级的兄弟插件 `../dsh-plugin-kirara-dev/` 是 Kirara 开发工具链插件（提供
> `kirara_profile` / `kirara_build` / `kirara_start` 等工具），与本插件互不依赖，
> 但共用同一套部署脚本结构与宿主包禁忌（§4.1）。
