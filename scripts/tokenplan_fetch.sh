#!/usr/bin/env bash
# 抓取阿里云百炼 TokenPlan Credits 用量
# 依赖: browser-act, bailian-session（已登录）
# 用法: ./scripts/tokenplan_fetch.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SESSION="bailian-session"
export PATH="$HOME/.local/bin:$PATH"
OUTPUT_DIR="$PROJECT_DIR/data/tokenplan"
mkdir -p "$OUTPUT_DIR"

browser() {
  browser-act --session "$SESSION" "$@"
}

# 导航到用量页
browser navigate "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/uac-admin/organization/usage" > /dev/null 2>&1 || true
sleep 3

# 提取模型用量（table 0）
MODEL_USAGE=$(browser eval '
JSON.stringify((() => {
  const table = document.querySelectorAll("table")[0];
  if (!table) return [];
  const results = [];
  table.querySelectorAll("tr").forEach(r => {
    const cells = r.querySelectorAll("td");
    if (cells.length === 3) {
      const name = cells[1].textContent.trim();
      const val = cells[2].textContent.trim();
      const m = val.match(/^([\d.,]+)/);
      if (m && name) results.push({model: name, credits: parseFloat(m[1].replace(/,/g, ""))});
    }
  });
  return results;
})())
' 2>/dev/null || echo '[]')

# 提取明细数据（table 2，抽屉中）
DETAIL=$(browser eval '
JSON.stringify((() => {
  const table = document.querySelectorAll("table")[2];
  if (!table) return [];
  const results = [];
  table.querySelectorAll("tr").forEach(r => {
    const cells = r.querySelectorAll("td");
    if (cells.length >= 4) {
      const ts = cells[0].textContent.trim();
      const model = cells[1].textContent.trim();
      const type = cells[2].textContent.trim();
      const val = cells[3].textContent.trim();
      const m = val.match(/^([\d.,]+)/);
      if (m && /^\d{4}-\d{2}-\d{2}/.test(ts)) {
        results.push({time: ts, model, type, credits: parseFloat(m[1].replace(/,/g, ""))});
      }
    }
  });
  return results;
})())
' 2>/dev/null || echo '[]')

# 提取成员席位用量 — 有效期内总消耗
MEMBER_USAGE=$(browser eval '
JSON.stringify((() => {
  const table = document.querySelectorAll("table")[1];
  if (!table) return 0;
  let total = 0;
  table.querySelectorAll("tr").forEach(r => {
    const cells = r.querySelectorAll("td");
    if (cells.length >= 4) {
      const val = cells[2].textContent.trim();  // 席位用量
      const m = val.match(/^([\d,]+\.?\d*)\s*Credits/i);
      if (m) total += parseFloat(m[1].replace(/,/g, ""));
    }
  });
  return total;
})())
' 2>/dev/null || echo '0')

# 写入 JSON
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DATE=$(date +%Y%m%d)

cat > "$OUTPUT_DIR/latest.json" << JSONEOF
{
  "ts": "$TIMESTAMP",
  "model_usage": $MODEL_USAGE,
  "detail": $DETAIL,
  "member_usage_credits": $MEMBER_USAGE
}
JSONEOF

cp "$OUTPUT_DIR/latest.json" "$OUTPUT_DIR/tokenplan_${DATE}.json"

# 同步到 routing_policy.json（dashboard 数据源）
python3 -c "
import json, os, sys
from datetime import datetime, timezone

with open('$OUTPUT_DIR/latest.json') as f:
    scraped = json.load(f)

used = float(scraped.get('member_usage_credits', 0))
CREDITS_TOTAL = 100000   # 团队版·高级座席固定配额
remaining = round(CREDITS_TOTAL - used, 2)
ts = scraped.get('ts', '')

policy_path = '$POLICY_PATH'
if os.path.exists(policy_path):
    with open(policy_path) as f:
        policy = json.load(f)
else:
    policy = {'token_plan': {}}

tp = policy.setdefault('token_plan', {})

# 清除手工基线 — 转由自动抓取驱动
tp.pop('manual_baseline', None)
tp.pop('manual_updated_at', None)

# 用 browser-act 抓取的 remaining 作为 baseline，proxy 只扣抓取之后的增量
tp['manual_baseline'] = remaining
tp['manual_updated_at'] = ts
tp['credits_remaining'] = remaining
tp['credits_total'] = CREDITS_TOTAL
tp['plan_duration_days'] = 30
tp['plan_start_ts'] = ts  # proxy 的 get_real_credits() 从此之后扫描增量
tp['last_updated_at'] = ts
tp['source'] = 'browser-act'

with open(policy_path, 'w', encoding='utf-8') as f:
    json.dump(policy, f, indent=2, ensure_ascii=False)

models = ', '.join(f'{m[\"model\"]}={m[\"credits\"]}' for m in scraped.get('model_usage', []))
print(f'OK: remaining={remaining} total={CREDITS_TOTAL} | {models} | {len(scraped.get(\"detail\", []))} details | synced')
"
