# 构建与部署

## 前置条件

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 22.22.x | 上游 `engines` 要求 `^22.22.1` |
| pnpm | 11.8.0 | 与上游 `packageManager` 一致，用 corepack 自动切换 |
| Docker | 任意近期版本 | 仅容器构建需要 |

## 一、裸机构建

```bash
git clone https://github.com/langgenius/dify.git dify
git clone https://github.com/kelvinchoi/dify-legacy-chromium.git
bash dify-legacy-chromium/scripts/apply.sh ./dify
```

Windows 上执行权限可能丢失，用 `bash dify-legacy-chromium/scripts/apply.sh ./dify` 代替。

`apply.sh` 会 checkout 到 `upstream.json` 里钉死的 commit，再按编号顺序 `git apply`。任何一条失败都会停下并打印 `.rej` 位置，不会写出半应用状态。

**补丁应用后必须重新安装依赖**。因为补丁 0001 在 `pnpm-workspace.yaml` 里加入了 `patchedDependencies`，lock 文件里的 `patch_hash` 要和实际的 patch 内容对得上：

```bash
cd dify
pnpm install
```

然后构建。`basePath` 按部署路径来，根路径部署就不要设这个变量：

```bash
cd web
NEXT_PUBLIC_BASE_PATH=/dify pnpm build
```

`pnpm build` 的脚本已经被补丁 0004 改成 `next build && node ./scripts/legacy-css-downlevel.mjs`，CSS 降级会自动跑，不需要额外步骤。这个脚本会递归处理 `.next` 下所有 CSS，包括 `.next/standalone` 里的副本。

### 跑 standalone

Next 的 standalone 产物**不包含** `public/` 和 `.next/static`，必须手动搬过去，否则静态资源和图标全 404：

```bash
cd web
cp -r public .next/standalone/web/
mkdir -p .next/standalone/web/.next
cp -r .next/static .next/standalone/web/.next/

cd .next/standalone/web
PORT=3000 HOSTNAME=0.0.0.0 node server.js
```

如果 standalone 目录需要读取运行时环境变量，记得把 `.env` 或 `.env.local` 也复制进去——Next 不会自动带上。

## 二、容器构建

`web/Dockerfile` 在第 15 行已经预留了构建参数：

```dockerfile
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH="$NEXT_PUBLIC_BASE_PATH"
```

这个 `ENV` 在 base 阶段声明，builder 和 production 阶段都会继承，所以**构建时和运行时拿到的值一致**——这正是静态资源路径不出问题的前提。

```bash
docker build \
  -f web/Dockerfile \
  --build-arg NEXT_PUBLIC_BASE_PATH=/dify \
  -t dify-web:1.15.0-legacy .
```

补丁 0001 已经在 Dockerfile 里加了一行 `COPY patches /app/patches`。**少了这行 `pnpm install --frozen-lockfile` 会直接失败**，因为 `patchedDependencies` 指向的还是个不存在的路径。自己维护 Dockerfile 时别把这条删掉。

一个可选的加速项：Dockerfile 里是 `pnpm build && pnpm build:vinext`，而运行时 `EXPERIMENTAL_ENABLE_VINEXT=false`。如果你确定不用 vinext，可以把后半段去掉，构建时间能省不少。

## 三、运行时环境变量

至少要设这几个：

```bash
NEXT_PUBLIC_BASE_PATH=/dify      # 与构建时保持一致，否则资源路径会错位
CONSOLE_API_URL=                 # 留空表示走同源相对路径
SERVER_CONSOLE_API_URL=http://api:5001
```

`SERVER_CONSOLE_API_URL` 必须显式设。服务端组件走服务端请求，不能依赖浏览器同源；不设的话容器内会去请求 `localhost:5001`，在 compose 网络里那是容器自己。

## 四、nginx 子路径反代

`basePath=/dify` 的镜像期望收到**带前缀的完整路径**；后端的 api 路由仍然是 `/console/api`、`/api`、`/files`，所以反代要把前缀剥掉再转发。

```nginx
location = /dify { return 301 /dify/; }

location /dify/console/api/ {
  proxy_pass http://api:5001/console/api/;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 100m;
}

location /dify/ {
  proxy_pass http://web:3000;   # 末尾不加斜杠：原样传递 URI
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

如果哪天又看到 `/icon-192x192.png` 这类**根路径**的 404，先确认三件事：构建时设了 `NEXT_PUBLIC_BASE_PATH` 没有、运行时环境变量还在不在、页面 HTML 里输出的 `href` 到底带没带前缀。补丁 0005 已经把源码里的路径都改成拼前缀了，剩下的可能只剩「构建与部署用了不同的 basePath」这一种。

## 五、验收清单

1、`scripts/verify.sh` 全绿。
2、访问 `/polyfill-test`，页面能打开（它会在模块顶层调用 17 个 API，打不开就是没补上）。
3、开工作流编辑器，不白屏、能保存。
4、DevTools 里数 `styleSheets` 规则数，应在 5000 上下，不是 700 多。
5、Network 面板没有指向根路径的 404（图标、manifest、`_next` 三类都要看）。
