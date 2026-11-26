#!/usr/bin/env bash
# 把 patches/ 下的补丁应用到一份 Dify 源码上。
#
#   ./scripts/apply.sh /path/to/dify
#
# 行为：
#   1、校验目标目录是 git 仓库且工作区干净
#   2、checkout 到 upstream.json 里钉死的 commit（不用 tag，tag 会移动）
#   3、按编号顺序逐条 git apply，任何一条失败立即停止
#
# 不做的事：不跑 pnpm install。补丁改动了 pnpm-workspace.yaml 的 patchedDependencies，
# 装依赖会重算 lock 里的 patch_hash，这一步留给你自己确认。

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "用法: $0 <dify 源码目录>" >&2
  exit 1
fi

DIFY_DIR=$(cd "$1" && pwd)
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname "$HERE")

# 注意：Git Bash 下 $ROOT 是 /c/... 形式，Node 不认，所以先 cd 再用相对路径。
read_meta() {
  ( cd "$ROOT" && node -e "process.stdout.write(String(require('./upstream.json').$1))" )
}

VERSION=$(read_meta version)
COMMIT=$(read_meta commit)

cd "$DIFY_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "错误：$DIFY_DIR 不是 git 仓库。请 git clone https://github.com/langgenius/dify.git" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "错误：$DIFY_DIR 有未提交的改动，先 commit 或 stash。" >&2
  git status --short >&2
  exit 1
fi

if ! git cat-file -e "${COMMIT}^{commit}" 2>/dev/null; then
  echo "[apply] 本地缺少 commit $COMMIT，尝试拉取..."
  git fetch --depth 1 origin "$COMMIT" || {
    echo "错误：无法获取 commit $COMMIT。完整克隆一次仓库，或先 git fetch origin $COMMIT。" >&2
    exit 1
  }
fi

if [ "$(git rev-parse HEAD)" != "$COMMIT" ]; then
  echo "[apply] 切换到 Dify $VERSION ($COMMIT)"
  git checkout --detach "$COMMIT"
fi

applied=0
for patch in "$ROOT"/patches/*.patch; do
  name=$(basename "$patch")
  if ! git apply --check "$patch" 2>/dev/null; then
    echo "" >&2
    echo "错误：$name 无法应用。" >&2
    echo "可能是上游代码已变。先看 git apply --check 的报错：" >&2
    git apply --check "$patch" >&2 || true
    echo "如果要跟到新版本，用 scripts/rebase-upstream.sh 重新对齐。" >&2
    exit 1
  fi
  git apply --whitespace=nowarn "$patch"
  applied=$((applied + 1))
  echo "[apply] 已应用 $name"
done

echo ""
echo "[apply] 完成：$applied 个补丁，基线 Dify $VERSION"
echo "下一步："
echo "  cd $DIFY_DIR && pnpm install"
echo "  cd $DIFY_DIR/web && NEXT_PUBLIC_BASE_PATH=/dify pnpm build"
