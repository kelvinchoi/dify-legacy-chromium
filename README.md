# dify-legacy-chromium

[![verify](https://github.com/kelvinchoi/dify-legacy-chromium/actions/workflows/ci.yml/badge.svg)](https://github.com/kelvinchoi/dify-legacy-chromium/actions/workflows/ci.yml)

让 [Dify](https://github.com/langgenius/dify) 在 Chromium 90 - 114 的老内核浏览器上正常跑的补丁集。

> **非官方项目**。与 LangGenius, Inc. 无隶属或背书关系。补丁属衍生作品，沿用 Dify Open Source License；请先读 [LICENSE](./LICENSE) 里的两条附加条款（多租户、LOGO），详见 [NOTICE](./NOTICE)。

## 这东西解决什么

不少内网终端上的 Chromium 内核常年停在 90 上下。这类环境装不了新版 Chrome，也不方便换浏览器。原版 Dify 1.15 在这些内核上有四层问题，任何一层没修都是白屏或完全无样式：

| 层 | 现象 | 原因 |
|---|---|---|
| wasm | 工作流编辑器白屏 | `loro-crdt` 在模块求值时同步编译 3.1MB wasm，老内核不允许 |
| CSS | 页面能开但毫无样式 | Tailwind v4 产物整体包在 `@layer` 里，Chrome 90 把整层当未知 at-rule 丢弃 |
| CSS | 侧边栏图标上多一块橙色方块 | `translate-y-*` 编译成独立的 `translate:` 属性，需要 Chrome 104+ |
| JS | 随机位置抛 TypeError 崩溃 | `structuredClone`、`Promise.withResolvers`、`crypto.randomUUID`、`Object.groupBy` 等 API 不存在 |

逐层的原因推演、实测证据见 [docs/why-chromium-90.md](./docs/why-chromium-90.md)。

## 支持矩阵

| 浏览器内核 | 状态 | 说明 |
|---|---|---|
| Chromium 115+ | 原生可用 | 补丁装上也无副作用：polyfill 检测到原生实现后直接跳过 |
| Chromium 90 - 114 | **本仓库目标区间** | 应用本仓库全部补丁 |
| Chromium 85 - 89 | 理论可用，未验证 | 语法层满足；API 层还需补 `String.replaceAll`、`Promise.any`、`WeakRef` |
| Chromium 80 - 84 | 不可用 | 产物含 `??=` / `\|\|=`，解析期直接 SyntaxError，polyfill 救不了 |

实测基准：Chromium 90.0.4430.246。各特性的内核门槛与实测数据见 [docs/compatibility.md](./docs/compatibility.md)。

## 快速开始

```bash
# 1. 取补丁与上游源码（sha 已在 upstream.json 里钉死）
git clone https://github.com/kelvinchoi/dify-legacy-chromium.git
git clone https://github.com/langgenius/dify.git dify

# 2. 应用补丁（会 checkout 到指定 commit 再逐条 apply）
bash dify-legacy-chromium/scripts/apply.sh ./dify

# 3. 装依赖并构建（basePath 按你的部署路径来，根路径部署就不要设）
cd dify && pnpm install
cd web && NEXT_PUBLIC_BASE_PATH=/dify pnpm build
```

`pnpm build` 已经串了构建后处理脚本，CSS 降级会自动完成，不需要额外命令。

Windows 下统一用 `bash scripts/xxx.sh` 调用，不要用 `./scripts/xxx.sh`——Git for Windows 不保留文件的执行位，直接执行会报 permission denied。

构建产物验证：

```bash
bash dify-legacy-chromium/scripts/verify.sh ./dify/web
```

它会检查产物里是否还残留 `@layer`、是否混入了 Chrome 91+ 语法、子路径前缀是否一致，并打印 `translate:` / `dvh` / `color-mix()` 的基线数量。

## 补丁清单

| 补丁 | 解决的问题 | 触及的上游文件 |
|---|---|---|
| `0001-loro-async-wasm-init.patch` | wasm 改为显式异步初始化 | `patches/loro-crdt@1.13.5.patch`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`web/Dockerfile`、`core/loro-runtime.ts`、`core/collaboration-manager.ts` |
| `0002-legacy-chrome-polyfills.patch` | 补齐 17 项缺失 JS API | `web/polyfills/legacy-chrome.ts`、`web/instrumentation-client.ts`、`web/app/polyfill-test/` |
| `0003-skip-link-transform.patch` | skip link 不再压住 logo | `web/app/components/main-nav/skip-nav.tsx` |
| `0004-postbuild-css-downlevel.patch` | 拍平 `@layer`，恢复样式 | `web/scripts/legacy-css-downlevel.mjs`、`web/package.json` |
| `0005-basepath-static-assets.patch` | 子路径部署下图标 404 | `web/app/layout.tsx`、`web/public/manifest.json`、`web/public/browserconfig.xml` |

补丁之间无强依赖，可以只取其中几条——但只取 0002 而不取 0001 仍然会白屏，因为编辑器卡在 wasm 那一层。

## 两个立刻能自检的点

1、**polyfill 是否装上了**：访问 `/polyfill-test`（补丁 0002 附带的自检页）。它在模块顶层直接调用全部 17 个 API，晚一步就白屏，所以这页能打开就意味着补齐成功。
2、**CSS 是否拍平了**：`grep -c '@layer' web/.next/static/chunks/*.css` 结果应为 0。

## 已知限制

1、**只能救 API，救不了语法**。产物里若出现 class static block、`#x in obj` 这类 Chrome 91+ 语法，老内核在解析期就失败，polyfill 无效。上游 `browserslist` 是 `last 1 Chrome version`，不做降级，所以每次跟进版本都要重新验证。想长期承诺 90，就要把 `browserslist` 改成 `chrome >= 90` 让构建器自己降级。
2、**视觉并非像素级一致**。产物里仍有约 38 处独立的 `translate:`、47 处 `dvh`、170 处 `color-mix()` 在 Chrome 90 上失效。它们不会崩，多包在 `@supports` 里会走兜底色，只是位移和高度会回落。要补齐需要给 `css-downlevel.mjs` 加对应转写，目前没做。
3、**PWA 安装**。manifest 里的图标路径已改成相对路径，子路径部署能正确解析；但 scope 会跟着 manifest 位置走，跨 workspace 的多实例部署请自行确认。
4、**不提供预构建镜像**。镜像含前端，分发要连带完整许可证与标识，且无法覆盖使用者的自定义配置。请按 [docs/build.md](./docs/build.md) 自己构建。

## 目录结构

```
patches/            五个补丁，按编号顺序应用
tools/              可脱离 Dify 单独使用的两个工具（MIT）
  css-downlevel.mjs     Tailwind v4 @layer 拍平器
  legacy-chrome.ts      老内核 JS API polyfill
scripts/            apply / verify / rebase-upstream
docs/               原因、兼容性数据、构建指引
upstream.json       钉住上游 version / tag / commit
```

## 跟进上游

上游每个版本都需要重新对齐补丁。流程是：

```bash
bash scripts/rebase-upstream.sh 1.16.0 /tmp/dify-next
```

脚本会把补丁按顺序 `git apply` 到新基线上，能自动过就自动过，冲突处保留 `.rej` 交给你修，最后重新导出 `patches/`。修完后记得更新 `upstream.json` 里的 `version` 和 `commit`。

如果你修的这几条恰好也是上游的问题，优先考虑直接提 PR——被合并一条，维护成本就少一块。本仓库的 `0002`、`0005` 属于明确的 bug 或纯增强，适合先提。

## 许可证

- `patches/` 及对 Dify 的修改：[Dify Open Source License](./LICENSE)（Apache 2.0 + 附加条款）
- `tools/` 与原创脚本：[MIT](./LICENSE-TOOLS)
