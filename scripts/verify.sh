#!/usr/bin/env bash
# 构建产物静态断言。
#
#   ./scripts/verify.sh [web 目录]        # 默认 ./web
#
# 把「能否在 Chromium 90 上运行」翻译成几条可自动化的判定：
#   FAIL = 一定跑不起来，或部署路径已经错位
#   WARN = 已知的视觉降级，不崩但和现代内核不一致
#   INFO = 基线数字，升级上游后拿来对比
#
# 这些数字对应 Dify 1.15.0 的产物，见 docs/compatibility.md。

set -uo pipefail

WEB_DIR=${1:-web}
CHUNKS="$WEB_DIR/.next/static/chunks"

if [ ! -d "$CHUNKS" ]; then
  echo "找不到 $CHUNKS —— 先构建：cd $WEB_DIR && NEXT_PUBLIC_BASE_PATH=/dify pnpm build" >&2
  exit 1
fi

fail=0
warn=0

fail_if_present() {
  local pattern=$1 label=$2 glob=$3
  if grep -rqE --include="$glob" -- "$pattern" "$CHUNKS" 2>/dev/null; then
    printf 'FAIL  %s\n' "$label"
    fail=1
  else
    printf 'PASS  %s\n' "$label"
  fi
}

count_of() {
  local pattern=$1 glob=$2
  grep -rhoE --include="$glob" -- "$pattern" "$CHUNKS" 2>/dev/null | wc -l | tr -d ' '
}

warn_if_measured() {
  local n=$1 label=$2
  printf 'INFO  %-34s %s\n' "$label" "$n"
  if [ "$n" -gt 0 ]; then warn=1; fi
}

echo "== 语法层（决定能否解析）=="
# Chrome 91+ 语法，出现即白屏且 polyfill 无效
fail_if_present 'static[[:space:]]*\{' 'JS 无 class static block（Chrome 94）' '*.js'

echo ""
echo "== 样式层（决定 CSS 是否被整层丢弃）=="
fail_if_present '@layer' 'CSS 无 @layer 残留（Chrome 99）' '*.css'

echo ""
echo "== 部署层（basePath 一致性）=="
manifest_bp=$( cd "$WEB_DIR" 2>/dev/null && node -e "try{process.stdout.write(require('./.next/routes-manifest.json').basePath||'')}catch(e){process.stdout.write('')}" 2>/dev/null || true )
env_bp=${NEXT_PUBLIC_BASE_PATH:-}
if [ -n "$env_bp" ]; then
  if [ "$manifest_bp" = "$env_bp" ]; then
    printf 'PASS  构建与运行 basePath 一致（%s）\n' "$env_bp"
  else
    printf 'FAIL  构建 basePath="%s" 与运行 NEXT_PUBLIC_BASE_PATH="%s" 不一致\n' "$manifest_bp" "$env_bp"
    fail=1
  fi
else
  printf 'SKIP  未设置 NEXT_PUBLIC_BASE_PATH，跳过 basePath 一致性检查（产物当前是 "%s"）\n' "$manifest_bp"
fi

if [ -f "$WEB_DIR/.next/standalone/web/server.js" ]; then
  [ -d "$WEB_DIR/.next/standalone/web/public" ] \
    && printf 'PASS  standalone 目录已包含 public\n' \
    || { printf 'FAIL  standalone 缺少 public 目录，静态资源会全部 404\n'; fail=1; }
  [ -d "$WEB_DIR/.next/standalone/web/.next/static" ] \
    && printf 'PASS  standalone 目录已包含 .next/static\n' \
    || { printf 'FAIL  standalone 缺少 .next/static\n'; fail=1; }
fi

echo ""
echo "== 基线数字（WARN 表示已知的视觉降级，不是故障）=="
warn_if_measured "$(count_of '[;{ ]translate *:' '*.css')" 'CSS translate: 独立属性（>104）'
warn_if_measured "$(count_of '[0-9]dvh' '*.css')" 'CSS dvh（>108）'
warn_if_measured "$(count_of 'color-mix\(' '*.css')" 'CSS color-mix()（>111）'
warn_if_measured "$(count_of ':has\(' '*.css')" 'CSS :has()（>105）'
if [ -n "${DIFY_LEGACY_NEW_BUILD:-}" ]; then
  warn_if_measured "$(count_of '@property' '*.css')" 'CSS @property（Chrome 85，正常）'
fi

echo ""
echo "== JS 语法基线（Chrome 85 是当前产物的地板）=="
printf 'INFO  %-34s %s\n' '可选链 ?.' "$(count_of '\?\.' '*.js')"
printf 'INFO  %-34s %s\n' '空值合并 ??' "$(count_of '\?\?' '*.js')"
printf 'INFO  %-34s %s\n' '逻辑赋值 ||= / ??=' "$(count_of '\|\|=|\?\?=' '*.js')"

echo ""
if [ $fail -ne 0 ]; then
  echo "结果：存在 FAIL 项，产物不适合部署到 Chromium 90。"
  exit 1
fi

if [ $warn -ne 0 ]; then
  echo "结果：无 FAIL。存在视觉降级项（见上），功能可用但和现代内核不完全一致。"
  exit 0
fi

echo "结果：全部通过。"
