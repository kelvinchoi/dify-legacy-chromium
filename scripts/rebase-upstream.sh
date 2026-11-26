#!/usr/bin/env bash
# 把补丁对齐到新的上游版本。两步走，中间留给人工解冲突。
#
#   1) 准备并应用
#      ./scripts/rebase-upstream.sh 1.16.0 /tmp/dify-next
#      —— clone 新 tag，按顺序 apply。冲突处生成 .rej 并停下。
#
#   2) 修完冲突后重新导出
#      ./scripts/rebase-upstream.sh export /tmp/dify-next
#      —— 按每个 patch 涉及的文件集合重新切 diff，覆盖 patches/。
#         原补丁会先备份到 patches.bak-<时间戳>/。
#
# 为什么按「文件集合」而不是按 commit 重组：解冲突时你可能会新增多个 commit，
# 甚至 amend 到旧 commit 上。按文件归组与 commit 结构无关，结果更稳定。

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname "$HERE")
UPSTREAM=https://github.com/langgenius/dify.git

die() { echo "错误：$*" >&2; exit 1; }

mode=${1:-}
case "$mode" in
  export)
    DIR=${2:-}
    [ -n "$DIR" ] || die "用法: $0 export <工作目录>"
    cd "$DIR"

    BASE=$(git rev-list --max-parents=0 HEAD 2>/dev/null | tail -1)
    # 工作副本是 --depth 1 clone 出来的，根 commit 就是基线；但补丁都应用在基线之后，
    # 所以基线应该是「第一个加了补丁的 commit 的 parent」。这里用 tag 反查更稳：
    TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)
    if [ -n "$TAG" ]; then
      BASE=$(git rev-parse "$TAG^{commit}")
    fi
    [ -n "$BASE" ] || die "无法确定基线 commit"

    STAMP=$(date +%Y%m%d-%H%M%S)
    BACKUP="$ROOT/patches.bak-$STAMP"
    cp -r "$ROOT/patches" "$BACKUP"
    echo "[rebase] 原补丁已备份到 $BACKUP"

    for old in "$ROOT"/patches/*.patch; do
      name=$(basename "$old")
      # 从旧补丁里取出它碰过的文件列表，按这个范围重新切 diff
      files=$(grep '^diff --git ' "$old" | sed -E 's|^diff --git a/[^ ]+ b/||')
      [ -n "$files" ] || { echo "[rebase] 跳过 $name（解析不出文件列表）"; continue; }
      # shellcheck disable=SC2086
      git diff "$BASE"..HEAD -- $files > "$ROOT/patches/$name"
      if [ -s "$ROOT/patches/$name" ]; then
        echo "[rebase] 重新导出 $name  ($(wc -l < "$ROOT/patches/$name") 行)"
      else
        echo "[rebase] 警告：$name 变空了，对应改动可能已被上游吸收"
      fi
    done

    echo ""
    echo "[rebase] 完成。接下来："
    echo "  1. 跑 ./scripts/apply.sh $DIR 验证新的补丁能干净应用"
    echo "  2. 更新 upstream.json 里的 version / commit（当前 HEAD: $(git rev-parse HEAD)）"
    exit 0
    ;;

  ""|-h|--help)
    sed -n '2,20p' "${BASH_SOURCE[0]}"
    exit 0
    ;;

  *)
    TAG="$mode"
    DIR=${2:-}
    [ -n "$DIR" ] || die "用法: $0 <新 tag> <工作目录>"
    ;;
esac

if [ ! -d "$DIR/.git" ]; then
  echo "[rebase] 克隆 Dify $TAG 到 $DIR"
  git clone --depth 1 --branch "$TAG" "$UPSTREAM" "$DIR"
else
  echo "[rebase] 复用已有目录 $DIR"
  cd "$DIR"
  git fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
  git checkout --detach "$TAG"
fi

cd "$DIR"
echo "[rebase] 基线：$TAG ($(git rev-parse HEAD))"

conflicts=0
for patch in "$ROOT"/patches/*.patch; do
  name=$(basename "$patch")
  if git apply --check "$patch" 2>/dev/null; then
    git apply --whitespace=nowarn "$patch"
    git add -A >/dev/null
    git -c user.name=rebase -c user.email=rebase@local commit -q -m "$name"
    echo "[rebase] OK    $name"
  else
    echo "[rebase] 冲突  $name"
    git apply --reject --whitespace=nowarn "$patch" >/dev/null 2>&1 || true
    conflicts=$((conflicts + 1))
  fi
done

echo ""
if [ "$conflicts" -ne 0 ]; then
  cat <<EOF
有 $conflicts 个补丁没干净应用，已用 --reject 留下 .rej 文件：

  find $DIR -name '*.rej'

逐个打开对照修改，改完提交（commit 信息随意），然后执行：

  $0 export $DIR

脚本会按每个补丁涉及的文件重新切 diff，不依赖 commit 结构。
EOF
  exit 1
fi

echo "全部应用成功。执行下面这条完成导出："
echo "  $0 export $DIR"
