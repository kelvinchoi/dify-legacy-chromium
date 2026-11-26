# 兼容性实测数据

以下数字都是在 **Dify 1.15.0、commit 3aa26fb** 的产物上数出来的。上游每次升级都会变，所以这些数字的正确用法是「当作基线，升级后重测并对比」，而不是当成常数。

复现方式都写在每节末尾。

## JS 语法基线：Chrome 85

这是决定「能不能解析」的硬指标，比任何 API 补丁都重要——语法错误发生在解析期，polyfill 来不及执行。

| 语法 | 产物出现次数 | 最低内核 |
|---|---|---|
| 可选链 `?.` | 24157 | 80 |
| 空值合并 `??` | 8175 | 80 |
| 逻辑赋值 `\|\|=` | 58 | 85 |
| 逻辑赋值 `??=` | 37 | 85 |
| `#private` 字段/方法 | 大量 | 84 |
| class `static {}` 块 | 0 | 94 |
| `#x in obj` 品牌检查 | 0 | 91 |

结论：**当前产物的语法基线是 Chrome 85**，不是 90。所以在 90 上能跑，靠的是产物恰好只用到 85 级语法，而不是补丁的功劳。

这也意味着它是脆弱的：上游 `browserslist` 写的是 `last 1 Chrome version`，不做降级。下次升级只要产物里出现一处 Chrome 91+ 语法，90 就会立刻白屏，而本仓库的 JS 补丁全部失效。

```bash
# 复现
grep -o -E '\?\?=|\|\|=' web/.next/static/chunks/*.js | wc -l
grep -o -E 'static *\{'      web/.next/static/chunks/*.js | wc -l
grep -o -E '#[a-zA-Z_$]+ in ' web/.next/static/chunks/*.js | wc -l
```

要长期承诺 90，就把 `web/package.json` 的 `browserslist` 改成 `chrome >= 90`，让 SWC 自己降级。这一步本仓库没有替你做，因为它会改变产物、影响所有用户的新内核表现，应该由部署方决定。

## CSS 特性

| 特性 | 产物出现次数 | 最低内核 | 本仓库的处理 |
|---|---|---|---|
| `@layer` | 0（已拍平） | 99 | ✅ 0004 拍平 |
| `@property` | 218 | 85 | 无需处理 |
| `color-mix()` | 170 | 111 | ❌ 未处理，多数包在 `@supports` 内，走前置兜底色 |
| `dvh` | 47 | 108 | ❌ 未处理，`calc(100dvh - Npx)` 整条失效 |
| `translate:` 独立属性 | 38 | 104 | ⚠️ 只修了 skip link 一处 |
| `:has()` | 37 | 105 | ❌ 未处理，该条规则被丢弃，不连坐 |
| `@container` | 1 | 105 | ❌ 未处理 |

所以「Chrome 90 下能用」准确的含义是：**功能可用，视觉有已知降级**。位移、视口高度、部分悬停色会回落，页面不会崩。

`color-mix()` 之所以可以放一放，是因为上游把大多数用法包在了特性检测里：

```css
background: #0000ff40;
background: color-mix(in srgb, AccentColor, transparent 75%);
```

老内核只有第一行生效。这不是巧合，是写法规避，值得在自己的项目里照抄。

```bash
# 复现
cat web/.next/static/chunks/*.css | grep -o 'color-mix(' | wc -l
cat web/.next/static/chunks/*.css | grep -o -E '[0-9]dvh' | wc -l
cat web/.next/static/chunks/*.css | grep -o -E '[;{ ]translate *:' | wc -l
cat web/.next/static/chunks/*.css | grep -o '@layer' | wc -l   # 应为 0
```

## CSS 拍平效果

同一份 Dify 1.15.0 的 CSS，同一台 Chromium 90：

| 指标 | 处理前 | 处理后 |
|---|---|---|
| 浏览器可解析规则数 | 723 | 5047 |
| 输入框尺寸 | 161 × 22 | 400 × 32 |
| 输入框边框 / 圆角 | 无 / 0 | 1px / 8px |

规则数用 `document.styleSheets` 遍历计数：

```js
[...document.styleSheets].reduce((n, s) => n + s.cssRules.length, 0)
```

## 功能回归

Chromium 90.0.4430.246 上跑了 26 项主链路回归，全部通过，`RESIDUAL_ERRORS=0`、`NET_FAILURES=0`。

覆盖范围：登录/登出、应用列表与筛选、DSL 导入导出、工作流编辑器打开与保存、节点增删、知识库创建与检索、模型供应商配置、发布为 API、成员与设置页。

数据洁净性单独验了三轮：回归起止各做一次数据快照比对，除 `updated_at` 字段会因 Dify 自身的 `visibilitychange` 草稿同步而刷新外，其余字段无变化。对 `POST /console/api/apps/<id>/workflows/draft` 做写拦截后重跑，全字段一致，确认回归不产生业务副作用。

## 老内核测试环境怎么搭

CI 里跑不了 Chromium 90——Chrome for Testing 最低只到 113，更早的版本只能从 chromium-browser-snapshots 取。所以本仓库的 `scripts/verify.sh` 走的是**产物静态断言**路线：把「能否在老内核运行」翻译成几条可自动化的 grep 判定，比人工点一遍可靠，也能进 CI。

真机验证仍然值得做一次，尤其是 CSS 降级这类视觉问题。找一台装着目标浏览器的机器，打开 `/polyfill-test` 看是否白屏，再开开发者工具数一下 `styleSheets` 的规则数即可。
