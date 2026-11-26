# 为什么 Chromium 90 会挂，以及每一层怎么定位

这份文档是排查记录，不是教程。四层问题的顺序就是实际踩到的顺序——每修一层，下一层才会暴露出来。如果你只关心怎么用，看 README 就够。

## 背景：目标内核的硬指标

一些环境里 Chromium 内核长期停在 90 左右（常见于不联网的内网终端，浏览器更新被冻结在某个旧版本）。这个版本对本文涉及的几项能力是这样：

| 能力 | Chrome 90 | 需要的最低版本 |
|---|---|---|
| CSS `@layer` | ✗ | 99 |
| CSS 独立属性 `translate` | ✗ | 104 |
| CSS `dvh` | ✗ | 108 |
| CSS `color-mix()` | ✗ | 111 |
| CSS `:has()` | ✗ | 105 |
| JS 逻辑赋值 `??=` `\|\|=` | ✓ | 85 |
| `#private` 方法 | ✓ | 84 |
| `structuredClone` | ✗ | 98 |
| `Promise.withResolvers` | ✗ | 119 |
| `crypto.randomUUID` | ✗ | 92 |
| `Object.groupBy` | ✗ | 117 |

注意最后四行的差别：**前三行是"样式不对"，后四行是"直接崩"**。所以修的顺序是先让页面能渲染，再让样式回来，最后补运行时的坑。

## 第一层：工作流编辑器白屏，wasm 编译失败

### 现象

登录、应用列表都正常，一进工作流编辑器整个页面白掉，控制台里是 wasm 相关的异常。

### 定位

`loro-crdt` 是 Dify 用来做协同编辑的 CRDT 库，随包含一个 3,110,443 字节的 wasm。它 1.13.5 的入口是同步的：

```js
// 模块顶层，import 的时候就执行
const wasm = instantiateSync(loadWasmBytesSync(...))
finalize(wasm)
```

老内核不允许在主线程上这么大块地同步编译 wasm。更麻烦的是它发生在**模块求值期**，不是某个函数调用里——所以你连 try/catch 都插不进去，整个 chunk 直接失败。

### 修法

把初始化改成显式异步：`fetch` 取字节 → `WebAssembly.compile` → `WebAssembly.instantiate`，编译结果缓存在 `globalThis` 上。用 pnpm 的 `patchedDependencies` 打这个补丁，而不是 fork 一份 loro。

两个坑值得单独记：

1、`WebAssembly.instantiate(Module, imports)` 返回的是 **`Instance` 本身**；只有传 bytes 时才返回 `{ module, instance }`。所以取值要写成 `instantiated.instance || instantiated`。
2、**不要用 top-level await 实现这套逻辑**。Turbopack 和 webpack 遇到这个包的 TLA 都会让构建挂住，症状是构建无输出地卡死，极难定位。

修完之后编辑器能开了，但页面**完全没有样式**——这就是第二层。

## 第二层：页面有 DOM 但零样式

### 现象

HTML 结构完整，能选中、能点击，但所有颜色、间距、布局都没有。

### 定位

量一下就知道：Chrome 90 下浏览器能解析出 **723** 条规则。而产物 CSS 有五千多条。差了一个数量级，说明大块内容被整段丢弃了。

Dify 从 1.14 起把 Tailwind 升到 v4，v4 的输出固定包在级联层里：

```css
@layer theme, base, components, utilities;
@layer theme { ... }
@layer base { ... }
@layer utilities { ... }   /* 全部工具类在这里 */
```

`@layer` 需要 Chrome 99+。低版本内核把它当未知 at-rule，**连同块内所有规则一起丢弃**——不是忽略层声明，是整块不要了。`utilities` 层就是全部 Tailwind 工具类。

### 修法

构建后处理：删掉层声明，把层块原位展开成普通 CSS。产物里层块的物理顺序本来就是 `theme → base → components → utilities`，和声明顺序一致，所以原地展开不会反转覆盖关系。

处理后同一份 CSS 在 Chrome 90 上可解析规则数 723 → **5047**。输入框从「161×22 方角无边框」变成「400×32、1px 边框、8px 圆角」。

脚本有两个必须做的防御：幂等（已拍平的文件不含 `@layer`，直接跳过），以及展开后校验大括号平衡，失衡就报错退出而不是写出坏文件。

样式回来了，但侧边栏上多了一块不该有的东西——第三层。

## 第三层：skip link 压在 logo 上

### 现象

左侧栏最上方、logo 位置，多出一块橙色方块。

### 定位

它是无障碍用的「跳到主内容」链接（skip link）。设计上是隐藏在视口外的，按 Tab 聚焦时滑入。它写的是：

```
-translate-y-[calc(100%+0.75rem)]
```

Tailwind v4 对 `translate-y-*` 生成的不是 `transform: translateY()`，而是**CSS 独立变换属性**：

```css
translate: var(--tw-translate-x) var(--tw-translate-y);
```

`translate` 属性需要 Chrome 104+。Chrome 90 解析时把这条声明整条丢弃，`transform` 保持 `none`，于是元素停在 `fixed top:8px left:8px`，正好压住 logo。

### 修法

改成任意属性语法，直接产出 `transform`：

```diff
- '-translate-y-[calc(100%+0.75rem)]'
+ '[transform:translateY(calc(-100%_-_0.75rem))]'

- 'focus-visible:translate-y-0'
+ 'focus-visible:[transform:translateY(0)]'
```

**不能**在全局 CSS 里补一条 `a[href="#main-content"]{transform:…}` 了事。因为 `translate` 和 `transform` 在 CSS 里是**叠加**关系而非替代，新内核下两个都生效，元素会被移动两次。

实测：Chromium 90 下默认 `matrix(1,0,0,1,0,-48)`（y=-40，视口外），按一次 Tab 后 `matrix(1,0,0,1,0,0)`（y=8，正常显示）。

到这里视觉基本正常了，但交互还是会随机崩——第四层。

## 第四层：运行时缺 API

### 定位

不要靠猜。做法是写一个探针页，在**模块顶层**直接调用所有可疑 API：任何一个不存在，页面就白屏，因此"能打开"本身就是全通过的证明。再把 `window.onerror` 和 `unhandledrejection` 都挂上收集异常。

实测在 Chromium 90 上真正缺失的是 4 个：

| API | 产物调用点数 | 实际缺失 |
|---|---|---|
| `structuredClone` | 27 | ✓ |
| `Promise.withResolvers` | 42 | ✓ |
| `crypto.randomUUID` | 15 | ✓ |
| `Object.groupBy` / `Map.groupBy` | 若干 | ✓ |
| `Object.hasOwn` | 若干 | ✗（产物内已有 core-js 兜底） |
| `Array.prototype.at` | 若干 | ✗（同上） |

补丁实际补齐了 17 项，因为 Browserslist 目标会随上游变化，多补几项成本几乎为零，抗漂移能力更强。补的清单和理由在 `tools/legacy-chrome.ts` 顶部注释里。

### 接入位置很关键

必须放在客户端最早的入口（Next 的 `instrumentation-client.ts`）的**第一个 import**：

```ts
import './polyfills/legacy-chrome'

import { IS_DEV } from '@/config'
```

ES 模块按 import 出现顺序求值。放第一行，才能保证后面的 `@/config`、`@/env` 在自己的顶层代码里用到缺口 API 时不会炸。

不要改成「import 进来后在 `main()` 里调用」——虽然那样通常也生效，但模块求值顺序不再受你控制，风险更大。

### `structuredClone` 不能糊弄

原生 `structuredClone` 不能降级成 `JSON.parse(JSON.stringify())`：会丢 `Date`/`Map`/`Set`/`ArrayBuffer`，遇循环引用直接抛错。所以 `tools/legacy-chrome.ts` 里是一份完整的结构化克隆实现，覆盖 Date、RegExp、ArrayBuffer、TypedArray、DataView、Map、Set、Array、Error（含 `cause`）和循环引用。宿主对象（Blob/File/DOM 节点）原生会抛 `DataCloneError`，这里降级为共享引用——宁可共享也不要让业务崩。

## 顺带发现的一个部署问题

`NEXT_PUBLIC_BASE_PATH=/dify` 部署时，控制台会报 `GET /icon-192x192.png 404`——少了前缀。

原因不在 nginx：Next 只给自己生成的 `/_next/*` 资源加 basePath，**两类东西它不管**：

1、JSX 里手写的 `<link href="/...">`，原样输出；
2、`public/` 下静态文件的**内容**（`manifest.json`、`browserconfig.xml` 里的字符串），文件只是被挂到 basePath 下提供，内容不会被改写。

修法按「内容是否受构建控制」分开：`layout.tsx` 里用 `process.env.NEXT_PUBLIC_BASE_PATH` 显式拼前缀（构建时内联，与 `basePath` 取值时机一致；用 t3-env 的运行时读取反而会不一致）；`manifest.json` / `browserconfig.xml` 改成相对路径，按规范以文件自身 URL 为 base 解析，根部署与子路径部署一套文件通吃。

## 一句话总结

四层里只有第一层是 Dify 特有的，其余三层是所有「Tailwind v4 + Next.js + 老内核」项目都会遇到的通病。真正决定能不能跑的是**语法层**而不是 API 层——`??=` 这类语法在解析期就失败，任何运行时补丁都来不及生效。
