# DSH 客户端插件契约

本插件同时有宿主半与客户端半。宿主半的契约与普通 DSH 插件相同
（见 [dsh-plugin-kirara-dev 的插件契约](https://github.com/akeno6388/dsh-plugin-kirara-dev/blob/main/docs/plugin-contract.md)），
这里只讲客户端半特有的部分。

## `package.json` 的相关字段

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
  "peerDependencies": {                      // ← 永不安装
    "@deepseek-ai/dsh-tools": "^0.2.0-rc.2",
    "@deepseek-ai/schemastery": "~3.18.4"
  }
}
```

`dsh.client` 的合法字段**只有** `platform`（必填）/ `inject` / `external` / `immediately`。

## 客户端半的模块格式

DSH 的客户端插件是**经典脚本**，不是 ESM，格式固定：

```js
window.__ModuleLoader__.load({
  id: "@kirara/dsh-plugin-kirara-theme",   // 必须 === package.json 的 name
  factory: (require) => { var module = { exports: {} }; /* … */ return module.exports; }
});
```

规则：

- **有且只有一次** `load()` 调用，**不能**出现 `import` / `export`
- 依赖只能走 `require` 参数，且名字必须在白名单内（本插件一个都没用，所以 `dsh.client.external` 为空）
- 导出对象 = cordis 插件 `{ name, apply(ctx) }`
- 副作用统一放进 `ctx.effect(fn, "label")`，`fn` 返回清理函数
- 自建 `<style>` 必须同时带 `data-plugin` 与 `data-plugin-css` 两个属性，
  否则 `dsh-client-modules` 卸载时**回收不掉**这个 `<style>`
- 定时器用原始 `setTimeout` / `setInterval` 加 `timer.unref()`
  （`ctx.setTimeout` / `ctx.setInterval` 已是废弃别名）

## 颜色 token 必须先确认存在

引用 DSH 主题 token 之前，**必须先去 `theme-client.js` 里确认这个 `--dsw-*` token 真的存在**。
拿不准就不要碰颜色。

早期版本写过 `color: var(--dsw-alias-text-primary, #f5f6f8) !important`，后果是**整个界面文字、
图标全部消失**。原因是双重的：`--dsw-alias-text-primary` 这个 token 根本不存在
（真实 token 是 `--dsw-alias-label-primary`），自定义属性取不到值就回退到字面量 `#f5f6f8`，
于是近白色永远生效；而该声明带 `!important` 且落在 `body` 上，**继承会污染全树**。

现在两个半的 CSS 里**没有任何 `color` 声明**，只剩 `background-color:`。

> 任何写在 `html` / `body` 上的 `color … !important` 都会劫持整个应用的继承色。

## 主题真值

主题只有 `body[data-ds-dark-theme]` 一个可信来源：属性存在 = 深色，不存在 = 浅色。
没有 `data-ds-light-theme`，也没有 `data-color-scheme`。

## 无障碍回退

`prefers-reduced-transparency: reduce` 时全部退回不透明，这条媒体查询放在样式表最后，
并且深色变体一并列出 —— 只写浅色前缀压不过上面的深色规则（特异度更高）。

承担「露出照片」的每一层都要在这里换回实色：三个列、顶栏（外框 + 拖拽条）、输入区底座。
内层（`._2H3hWW_root` / `.Dc7zOa_root`）**始终**透明 —— 退回不透明只需要把承担颜色的那一层换成实色。
