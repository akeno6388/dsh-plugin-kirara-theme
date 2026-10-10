# dsh-plugin-kirara-theme

把 DeepSeek Harness（DSH）的 Web GUI 换上一套「Kirara Server App 首页」外观。

> Dresses the DSH Web GUI in the Kirara Server App home look.

具体来说：整屏背景图 + 半透明黑色遮罩 + 左侧栏 / 主界面 / 右侧栏三列半透明，Windows 顶栏直接露出背景图。
这张背景图**来自 Kirara 服务器**（`GET /api/resources/home-background`），不是打包在插件里的静态资源，
换图不需要重装插件。

装上后大概是这样：

- 整个窗口铺一张照片，`background-size: cover`，窗口缩放不变形、不留边
- 三个列铺半透明底，照片透出来，正文仍然清晰
- 左侧栏右上角带圆角，与内容卡左上角的圆角对称，两处缺口一起露出整屏背景
- Windows 顶栏（窗口顶端那条可拖拽的高带）不再盖一层灰底，看到的就是照片本身
- 右上角最小化 / 最大化 / 关闭三个按钮**直接坐在顶栏上**（标题栏底色置成全透明，不再有实色带）

> 「顶栏」和「标题栏」是两条不同的东西：前者是网页里的拖拽区（能清成透明），
> 后者由 Windows 合成器画在网页**之上**，CSS 碰不到 —— 插件只能改 preload 探针的计算后颜色，
> 让宿主把标题栏底色设成**全透明**，三个按钮图标于是直接压在顶栏（照片 + 遮罩）上。
> 详见[架构文档](docs/architecture.md)。

## 功能

| 能力 | 说明 |
| --- | --- |
| 外观层 | 背景图、遮罩、三列半透明、侧栏右上角圆角、Windows 顶栏透明露图 |
| 侧栏透明度 | 由 `SIDEBAR_ALPHA` 常量控制，调一个值就能改侧栏通透程度 |
| Windows 标题栏底色 | 置成全透明（浅色 `rgba(255,255,255,0.004)` / 深色 `rgba(0,0,0,0)`）后交给 Electron 的 `titleBarOverlay`，三个按钮图标直接压在顶栏上 |
| 首屏防白闪 | 样式在客户端脚本之前注入 `<head>`，首帧就是图或渐变，不会先白一下 |
| 背景图同步 | 跟随 302 落盘缓存，按版本号比对，版本没变就零下载 |
| 同源背景路由 | 图片从本机 `/kirara-theme/*` 发出，前端不跨域 |
| 换图 | 版本变了才离屏预解码，解码成功后才一次性换图，不闪 |
| 即时开关 | 插件列表里打开 / 关掉开关，外观**当帧**生效与还原，不重启、不刷新页面 |

背景图没有时回落成深色渐变，界面不会变空白。

「即时开关」这条要说清楚：打开开关时外观层（背景板、遮罩、三列半透明、顶栏透明）在同一帧
里生效，照片紧随一次**本机** `state.json` 请求 + 解码补上（不等 10s 轮询定时点）；
关掉开关时不仅移除插件自己的样式，还会把**宿主写进索引页的那份首屏样式**一并摘掉 ——
它是渲染索引页时注入的静态文本，不摘的话外观会一直留到刷新页面为止。

**插件不做的事**（刻意留白，改动前请先读[架构文档](docs/architecture.md)）：

- 不覆盖 `--dsw-specific-sidebar-fill` 之类的设计 token —— 改它会让菜单和所有浮层一起变半透明
- 不用 `backdrop-filter` / 亚克力 / 模糊
- 不用 `color-mix` / `@supports` / CSS 嵌套
- 绝不写 `color` —— 落在 `body` / `html` 上的 `!important` 颜色会被整棵树继承，把文字和图标全染成同色
- 不往 DOM 里插任何元素节点 —— 卸载 = 删掉两个 `<style>`（自己的 + 宿主写进索引页的首屏那份）
  + 摘掉 `<html>` 上的两个属性 + 停掉轮询

## 前置条件

不需要 Kirara 三端仓库，也不需要任何构建 —— 这是个纯外观插件。

唯一的外部依赖是**能返回背景图的服务器**。用插件默认的公开图源的话，连这个都不用准备。

插件依赖 DSH Web GUI 的内部 class 名 —— 但只依赖 **CSS Modules 的本地名后缀**
（`[class*="_sidebarCol"]`、`[class*="_root"][data-phase]` 之类），不依赖构建期哈希前缀。
所以官方 DSH 与 EduWork 这类内置了另一份 DSH 构建的宿主都能命中。宿主若改掉结构
（而不只是重新编译一次），外观层会静默失效（不报错），届时需要跟着更新插件。

## 安装

### 1. 添加插件

侧栏 **插件** → **添加插件**，填入仓库地址：

```
git+https://github.com/akeno6388/dsh-plugin-kirara-theme.git
```

也接受 `https://github.com/akeno6388/dsh-plugin-kirara-theme` 和本地绝对路径。
命令行等价物是 `dsh plugin --profile <profile> add <spec>`。

用 `git+https://` 而不是 `github:owner/repo` 简写：pnpm 会把简写改写成 `git+ssh://`，
没配 GitHub SSH key 的机器会直接 `Host key verification failed`。

如果 `github.com:443` 访问超时，可以换 Gitee 镜像地址。

### 2. 启用

安装完成界面点 **立即启用**，或回到插件列表打开该组合包的开关。

**之后开 / 关都不需要重启，也不需要刷新页面**：打开 → 外观当帧铺上；关掉 → 外观当帧撤干净。
这条链路由部署自检的第 7 项（「首屏样式可回收」）守着 —— 召回标记漂移会让「关掉后外观还在」
静默复发。

### 3. 首次登记仍要重启一次

**只有「第一次把本插件登记进 `dsh.profile.bundles`」这一步需要完全重启 DSH** ——
不是关窗口，也不是刷新页面：那份清单只在启动时读一次，运行中的进程不会感知。

登记过、重启过之后，插件列表里的开关就是即时的了（见上一节），不必再重启。
重启后刷新 GUI 应该就能看到背景图 —— 用的是插件默认的公开图源，不需要额外配置。

## 使用

### 换成你自己的服务器

默认指向 Kirara Server 的公开图源，所以装完即用。要让插件去拉你自己的服务器，
在自己 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: kirara-theme
  config:
    enabled: true
    apiBaseUrl: 'http://192.168.1.10:1010'
```

注意**覆盖是整行替换**：本文件里的 `enabled` 不再生效，所以要连 `enabled` 一起写；
其余字段留空会回落到插件内置默认值。手改这份补丁文件不会被运行中的进程感知，
改完同样要完全重启 DSH（插件管理界面里改配置则是即时生效的）。

### 你的服务器要实现什么

只需要一个接口：`GET <apiBaseUrl><endpoint>`，默认是 `/api/resources/home-background`。

```
GET /api/resources/home-background
  → 302 Found
     X-Resource-Version: 42
     Location: <图片地址，可以是预签名 URL>

GET <Location>
  → 200 OK
     Content-Type: image/jpeg
     ETag: "<md5>"
```

插件先手动接管 302（`redirect: 'manual'`），这样既能读到第一跳上那个廉价的版本头，
又能跟随后拿到图片本身的响应头，然后按下面的顺序推导版本标识：

1. 图片响应的 `ETag` —— 权威值
2. 第一跳的 `X-Resource-Version`
3. 图片响应的 `Last-Modified`

版本号没变就零下载。所以响应头里至少要带上其中一种稳定可比的标识 —— 推荐
`X-Resource-Version`（省一次下载就能判断）加 `ETag`（权威）。

服务端行为参考：图源不存在时返回 `404`，插件会记日志并保留当前已显示的图片，不把界面打回空白。

### 配置项

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` = 照常挂载路由与注入样式，但不做任何网络同步 |
| `apiBaseUrl` | `https://api.akeno6388.online:1010` | 图源地址，与 Kirara 客户端 `DefaultApiBaseUrl` 同源 |
| `endpoint` | `/api/resources/home-background` | 服务器返回 302 与 `X-Resource-Version` |
| `routePath` | `/kirara-theme` | 同源路由前缀，客户端半按它取图与轮询 |
| `syncIntervalMinutes` | `30` | 兜底轮询间隔，下限夹到 60 秒。客户端另有 10s / 180s 的快慢轮询 |
| `requestTimeoutMs` | `15000` | 单跳超时。图片走的是第二跳，也受这个值约束 |
| `cacheDir` | `''` | 留空则自动探测：`DSH_HOME` → `DSH_PROFILE_HOME` → `~/.dsh/kirara-theme` → 临时目录 |

### 调整侧栏透明度

侧栏是三列里最透的那个。实心度 = `1 - SIDEBAR_ALPHA`，当前 `SIDEBAR_ALPHA = 0.42`，
也就是侧栏实心度 `.58`；内容列和右侧栏固定在 `.86`。

**注意 `SIDEBAR_ALPHA` 是「透明度」而不是「不透明度」** —— 数字越大越透。
改的时候要同时改 `lib/index.js` 和 `lib/client.js` 里同名同值的常量，否则首屏样式与客户端样式会漂移，
出现「首帧一个样、脚本跑完变另一个样」的闪烁。改完跑：

```powershell
node scripts\check-css-parity.mjs
```

参考取值（以 `.55` 黑遮罩参与合成为前提）：

| `SIDEBAR_ALPHA` | 实心度 | 观感 |
| --- | --- | --- |
| `0.28` | `.72` | 几乎看不出照片，面板感最强 |
| `0.42` | `.58` | **当前值**，照片明显透出，正文仍然清晰 |
| `0.58` | `.42` | 侧栏明显融进背景，浅色主题下正文开始需要背景配合 |
| `0.72` | `.28` | 接近一层薄雾，正文可读性依赖背景图明暗 |

### 检查插件状态

DSH 在跑的时候，可以用路由状态码判断插件加载了没（端口换成 `dsh web` 打印的那个）：

```powershell
curl.exe -sS -o NUL -w "%{http_code}`n" http://127.0.0.1:19387/kirara-theme/state.json
```

| 路径 | 状态 | 含义 |
| --- | --- | --- |
| `/kirara-theme` 或 `/state.json` | `200` | 状态 JSON：`{version, hasImage, isDefault, backdrop}` |
| `/kirara-theme/background.jpg` | `302` → `/background/default` | 还没有远端图，客户端走渐变 |
| `/kirara-theme/background/default` | `200` | `{isDefault:true, backdrop:"<渐变 CSS>"}` |
| 同步完成后的 `background.jpg` | `200` + `etag` | 版本化不可变缓存 |

未加载或未重启时全部返回 `404`。

手动触发同步、或者丢弃缓存回到渐变：

```powershell
curl.exe -sS -X POST http://127.0.0.1:19387/kirara-theme/refresh
curl.exe -sS -X POST http://127.0.0.1:19387/kirara-theme/invalidate
```

## 兼容性

`peerDependencies` 声明为 `@deepseek-ai/dsh-tools@^0.2.0-rc.2`，覆盖 DSH 0.2.x 全系列
（`0.2.0-rc.2` / `0.2.0` / `0.2.1` 均可用）。

`0.3.0` 起会被判 incompatible 并自动禁用。换大版本后如果仍想用，需要 `dsh plugin allow-version`
显式授权 —— 插件没有针对新版本测过，有崩溃风险。

已知限制与取舍见[单独一篇](docs/limitations.md)。

## 升级

插件暂不支持自动更新。先在插件页卸载，再用新地址重装一次。

## 常见问题

**装完没有任何变化？**
第一次登记必须**完全重启 DSH**（见[安装 §3](#3-首次登记仍要重启一次)）——
`dsh.profile.bundles` 只在启动时读一次，关窗口和刷新页面都不算。
另外确认 profile 的 `dsh.profile.bundles` 里真的有这一项 ——
只写 `dependencies` 不写 `bundles`，插件会静默不生效。
（已经登记过、只是开关插件的话，**不需要**重启，见下一条。）

**开 / 关插件开关后外观没有立刻变化？**
打开应当**当帧**铺上外观、照片紧随一次本机请求补上；关掉应当**当帧**整个撤干净 ——
两者都不需要重启，也不需要刷新页面。若只做到一半：

| 症状 | 原因 | 怎么办 |
| --- | --- | --- |
| 关掉后背景 / 遮罩 / 半透明**还在** | 宿主写进索引页的那份首屏样式没能被摘掉。它靠 `BOOT_MARKER`（`lib/index.js` 与 `lib/client.js` 里逐字节一致的那行标记注释）配对，漂移即静默失效 | 跑 `node scripts\deploy.mjs --check`，第 7 项会直接点名；刷新页面也能暂时还原 |
| 打开后先是渐变、过一会儿才出图 | 客户端没在挂载时立刻探到 `state.json`（宿主可能还在读盘），落到了轮询节奏上 | 正常最多 1.5s（暖机重试）；一直不出图就查路由，见下面的「背景是空的」 |

两者都不是「要重启」——重启只影响**第一次登记**那一步。

**背景是空的 / 只有一片深色渐变？**
渐变是设计好的兜底，说明还没拿到远端图。检查 `GET <apiBaseUrl><endpoint>` 是否返回 302 与
`X-Resource-Version`，或者 `POST /kirara-theme/refresh` 强制同步一次看返回什么。

**主界面是纯色面板，只有侧栏能看见背景？**
说明宿主在内层容器上铺的不透明实色底没有被清掉。本插件会清掉会话主界面根
（`[class*="_root"][data-phase]`）与侧栏 / 右侧栏内部各面板根的底色；宿主若改掉了这层结构
（而不只是重新编译一次），这一处会失效。见[已知限制](docs/limitations.md)。

**菜单和弹出层也跟着变半透明了？**
那是改错了地方 —— 插件覆盖的是三个列元素自身的声明，没有动 `--dsw-specific-sidebar-fill` 这个 token。
如果你自己改过 CSS，回退到只给列铺底色、内层清成 `transparent` 的写法。

**右上角标题栏还是一条实色带？**
标题栏不是 DOM，是 Windows 合成器画的，普通 CSS 碰不到。插件通过改 preload 探针 span 的计算后颜色
来间接影响它 —— 那条规则把颜色设成 **alpha ≈ 0**（浅色 1/255、深色 0），正常情况下什么带子都不该看到。
如果还在，按顺序查两件事：① 探针规则有没有匹配上（探针行内 style 的文本变了就会失效，
见[故障排查](docs/troubleshooting.md)）；② 宿主是不是不支持带 alpha 的 overlay 色 ——
那种情况下带子会退回该颜色的 **RGB 分量**（浅色主题白、深色主题黑），这是刻意留的兜底，
观感上仍与顶栏同一色系。浅色那条写 `0.004` 而不是 `0` 正是为了这个（宿主会把 alpha=0 的
RGB 抹掉，`0.004` = 1/255 才能把白色保下来，且实测与 0 无任何观感差别）。

**标题栏能不能做成真透明？**
能，而且从这次修复起就是默认行为。Chromium 的 Window Controls Overlay 接受带 alpha 的颜色：
本宿主 Electron 44 实测推 `rgba(0,0,0,0)` ⇒ 三个按钮图标直接画在网页上、底下的顶栏原样透出，
整条带子消失。更早的文档记过「带 alpha 无效、只有不透明色生效」，那是旧实验条件下的误判 ——
真正卡住的是显式 `transparent` 关键字过不了宿主的值校验，而带 alpha 的 `rgba()` 一直可用，
详见[故障排查](docs/troubleshooting.md#windows-标题栏底色)。

**插件的背景图能改成静态文件吗？**
当前设计是必须来自服务器。想换图就在服务器侧换，`X-Resource-Version` 变了客户端会在 10 秒内跟着换，
不需要重装插件。

**能发到 npm 吗？**
可以，但发布前要先改三处，否则 `npm publish` 会被直接拒绝：

| # | 改什么 | 为什么 |
| --- | --- | --- |
| 1 | 删掉 `package.json` 的 `"private": true` | 它是 `npm publish` 的硬性拦截（不影响 git 安装） |
| 2 | 处理 `@kirara` 作用域 | npm 上 scoped 包必须有对应 organization；不想建就改包名，并同步改 profile 依赖名与 `dsh.profile.bundles` |
| 3 | 加 `"publishConfig": { "access": "public" }` | 不加会按默认可见性处理，可能发成私有 |

发布后用户可以只填包名安装，DSH 会在 npm 官方源与 npmmirror 之间自动探测。

**这个插件和 `dsh-plugin-kirara-dev` 什么关系？**
互不依赖。前者是 Kirara 三端项目的开发工具链插件，本插件是纯外观。两者共用同一套部署脚本结构，
以及同一条「宿主包只能声明为 `peerDependencies`」的禁忌。

**想改插件代码，怎么让改动生效？**
见[本地开发](docs/local-development.md)。

## 文档

- [架构与外观实现](docs/architecture.md) —— 图层怎么放、CSS 硬约束、复刻自 Kirara 的哪条链路
- [DSH 客户端插件契约](docs/plugin-contract.md) —— 客户端半的模块格式、`dsh.client` 字段、颜色 token
- [本地开发](docs/local-development.md) —— 挂载到 profile、部署脚本、12 项不变量、验收清单
- [故障排查](docs/troubleshooting.md) —— DevTools 核对脚本，以及几个已经踩过的坑
- [已知限制与取舍](docs/limitations.md) —— 宿主结构耦合、标题栏透明这些边界

## 许可

MIT
