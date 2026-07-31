/**
 * 把清洗产生的质量报告渲染成一个自包含的 HTML —— 双击即可打开，无需服务器。
 *
 *   node scripts/report.ts        （需先跑过 node scripts/clean.ts）
 *
 * 为什么单独做一个：数据接入不是一次性脚本，而是一个有运维回路的流程。
 * block 级问题需要有人看见、需要能被审核，藏在 JSONL 里没人会去看。
 * 刻意做成离线产物而不是站内路由：这是给运维看的，不是产品的一部分，
 * 不该跟着面向租客的站点一起部署。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DataIssue, Escalation, QualityReport, Severity } from "../src/lib/types.ts";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

const report: QualityReport = JSON.parse(readFileSync(join(DATA, "quality-report.json"), "utf8"));
const issues: DataIssue[] = readFileSync(join(DATA, "quality-issues.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

// ---------------------------------------------------------------------------

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function json(value: unknown): string {
  return value === undefined ? "" : esc(JSON.stringify(value));
}

/** 每条规则一句人话，让不看代码的人也能读懂报告 */
const RULE_LABELS: Record<string, string> = {
  duplicate_exact: "整行内容完全重复",
  rent_zero: "租金为 0，无法推断真实价格",
  rent_outlier_low: "租金远低于同类，疑似掉了一位数字",
  rent_outlier_high: "租金远高于同类，疑似多了一位数字",
  rent_unparseable: "租金格式无法解析",
  rent_format_string: "租金写成了字符串，已解析",
  deposit_unparseable: "押金格式无法解析",
  deposit_format_string: "押金写成了字符串，已解析",
  available_from_unparseable: "入住日期无法解析",
  available_from_text: "入住日期是自由文本，已落到参考日",
  mrt_missing: "未提供最近地铁站",
  district_missing: "未提供邮区",
  size_missing: "未提供面积",
  bedrooms_contradiction: "单间房源却标了多个卧室",
  area_normalized: "区域名有多余空格或大小写不一致，已规范化",
};

const SEVERITY_LABELS: Record<Severity, string> = {
  block: "移出推荐池，需人工介入",
  warn: "照常推荐，但 agent 必须披露",
  info: "自动规范化，不影响用户",
};

const severityOrder: Severity[] = ["block", "warn", "info"];

/**
 * escalation 和 severity 是正交的两个轴。
 * severity 说的是产品怎么表现，escalation 说的是要不要人来管、管的人是谁。
 */
const ESCALATION_TITLES: Record<Escalation, string> = {
  ops_review: "运维审核",
  source_followup: "回访房源方",
  none: "已自动处理",
};

const ESCALATION_NOTES: Record<Escalation, string> = {
  ops_review:
    "涉及硬过滤字段 —— 缺了或错了会让用户看到不该看到的房源，结果本身会变错，必须主动追",
  source_followup: "只影响软打分 —— 缺了只是少一个加分维度，不会让结果变错，低优先补齐",
  none: "清洗阶段已处理干净，无需任何人介入，仅留审计痕迹",
};

const actionable: Escalation[] = ["ops_review", "source_followup"];

function issueRows(list: DataIssue[]): string {
  return list
    .map(
      (i) => `<tr>
        <td class="mono">${esc(i.listingId)}</td>
        <td>${esc(RULE_LABELS[i.rule] ?? i.rule)}</td>
        <td><span class="tag ${i.severity}">${i.severity}</span></td>
        <td class="n mono">${json(i.raw)}</td>
        <td>${
          i.suggestedFix
            ? `<span class="fix">→ ${esc(i.suggestedFix.proposed)}</span>
               <span class="muted">${esc(i.suggestedFix.rule)} · 置信度 ${esc(i.suggestedFix.confidence)}</span>`
            : '<span class="muted">—</span>'
        }</td>
        <td class="muted">${esc(i.evidence ?? "")}</td>
      </tr>`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>数据质量报告 · Homie 租房 Agent</title>
<style>
  :root{
    --ink:#14181f; --ink2:#3d4654; --mute:#6c7686;
    --line:#e2e6ec; --line2:#f4f6f9; --bg:#fff;
    --accent:#0f766e; --accent-soft:#e6f4f2;
    --block:#b91c1c; --block-soft:#fdeeee;
    --warn:#b45309; --warn-soft:#fef4e6;
    --info:#1d4ed8; --info-soft:#eef2fe;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --ink:#f2f4f7; --ink2:#c8cfd9; --mute:#8b95a4;
      --line:#2c333d; --line2:#1b2027; --bg:#12161b;
      --accent:#5eead4; --accent-soft:#123834;
      --block:#fca5a5; --block-soft:#3a1c1c;
      --warn:#fcd34d; --warn-soft:#3a2c12;
      --info:#a5c0fd; --info-soft:#1a2440;
    }
  }
  *{box-sizing:border-box}
  body{
    margin:0; padding:32px 24px 64px; background:var(--bg); color:var(--ink2);
    font:14px/1.7 "PingFang SC","Hiragino Sans GB",-apple-system,"Helvetica Neue",sans-serif;
  }
  .wrap{max-width:1080px;margin:0 auto}
  h1,h2{color:var(--ink);font-weight:600;margin:0}
  h1{font-size:24px;letter-spacing:-.01em}
  h2{font-size:16px;margin:36px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  .sub{color:var(--mute);font-size:13px;margin-top:6px}
  code,.mono{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:.9em}

  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:22px 0 8px}
  .card{border:1px solid var(--line);border-radius:8px;padding:13px 15px}
  .card .v{font-size:26px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums;line-height:1.2}
  .card .k{font-size:12px;color:var(--mute);margin-top:2px}
  .card.block .v{color:var(--block)} .card.warn .v{color:var(--warn)} .card.info .v{color:var(--info)}

  table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0 4px}
  th{text-align:left;font-weight:600;color:var(--ink);background:var(--line2);padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:7px 10px;border-bottom:1px solid var(--line2);vertical-align:top}
  td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .scroll{overflow-x:auto}

  .tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 8px;border-radius:20px;white-space:nowrap}
  .tag.block{background:var(--block-soft);color:var(--block)}
  .tag.warn{background:var(--warn-soft);color:var(--warn)}
  .tag.info{background:var(--info-soft);color:var(--info)}

  .filters{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 4px}
  .filters button{
    font:inherit;font-size:12.5px;padding:5px 13px;border-radius:20px;cursor:pointer;
    border:1px solid var(--line);background:transparent;color:var(--ink2);
  }
  .filters button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--bg);font-weight:600}

  .fix{color:var(--accent);font-weight:600}
  .muted{color:var(--mute)}
  .note{background:var(--accent-soft);border-left:3px solid var(--accent);border-radius:6px;padding:11px 14px;margin:14px 0;font-size:13px}
  .note b{color:var(--ink)}
  footer{margin-top:44px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--mute)}
</style>
</head>
<body>
<div class="wrap">

  <h1>数据质量报告</h1>
  <div class="sub">
    <code>listings.json</code> → <code>listings.clean.json</code> ·
    生成于 ${esc(report.generatedAt)} · 参考日期 ${esc(report.referenceDate)}
  </div>

  <div class="cards">
    <div class="card"><div class="v">${report.input.rows}</div><div class="k">输入行数</div></div>
    <div class="card"><div class="v">${report.output.rows}</div><div class="k">去重后</div></div>
    <div class="card"><div class="v">${report.output.recommendable}</div><div class="k">可推荐</div></div>
    <div class="card block"><div class="v">${report.bySeverity.block ?? 0}</div><div class="k">block · ${esc(SEVERITY_LABELS.block)}</div></div>
    <div class="card warn"><div class="v">${report.bySeverity.warn ?? 0}</div><div class="k">warn · ${esc(SEVERITY_LABELS.warn)}</div></div>
    <div class="card info"><div class="v">${report.bySeverity.info ?? 0}</div><div class="k">info · ${esc(SEVERITY_LABELS.info)}</div></div>
  </div>

  <div class="cards">
    <div class="card block"><div class="v">${report.byEscalation.ops_review ?? 0}</div><div class="k">待运维审核</div></div>
    <div class="card warn"><div class="v">${report.byEscalation.source_followup ?? 0}</div><div class="k">待回访房源方</div></div>
    <div class="card"><div class="v">${report.byEscalation.none ?? 0}</div><div class="k">已自动处理，无需介入</div></div>
  </div>

  <div class="note">
    <b>severity 和 escalation 是正交的两个轴。</b>
    severity 说的是<b>产品怎么表现</b>（block 移出推荐池 / warn 照常推荐但披露 / info 静默规范化），
    escalation 说的是<b>要不要人来管、优先级多高</b>。两者不能合并：缺面积在产品上只需 warn
    （照常推荐 + 披露），但运维上是高优先级 —— 面积参与硬过滤，缺失时按「缺失≠不满足」放行，
    用户可能看到根本不符合面积要求的房源；而租金写成 "S$1200" 是 info，也确实不需要任何人管。
  </div>

  ${actionable
    .map((level) => {
      const list = issues.filter((i) => i.escalation === level);
      return `
  <h2>${ESCALATION_TITLES[level]}（${list.length} 条）</h2>
  <div class="note">${esc(ESCALATION_NOTES[level])}</div>
  <div class="scroll">
  <table>
    <thead><tr>
      <th>房源</th><th>问题</th><th>产品行为</th><th class="n">原始值</th><th>修复建议</th><th>判定依据</th>
    </tr></thead>
    <tbody>
${issueRows(list)}
    </tbody>
  </table>
  </div>`;
    })
    .join("\n")}

  <div class="note">
    <b>修复建议只进报告，不写回业务字段。</b>
    租金错误在租房产品里伤害最大 —— 用户按 $185 约看房、到场发现是 $1,850，信任就没了。
    系统提出建议，改不改由人决定。
  </div>

  <h2>按规则统计</h2>
  <div class="scroll">
  <table>
    <thead><tr><th>规则</th><th>说明</th><th>产品行为</th><th>处理方</th><th class="n">数量</th></tr></thead>
    <tbody>
      ${Object.entries(report.byRule)
        .map(([rule, count]) => {
          const sample = issues.find((i) => i.rule === rule);
          const severity = sample?.severity ?? "info";
          const escalation = sample?.escalation ?? "none";
          return `<tr>
        <td class="mono">${esc(rule)}</td>
        <td>${esc(RULE_LABELS[rule] ?? "")}</td>
        <td><span class="tag ${severity}">${severity}</span></td>
        <td>${escalation === "none" ? '<span class="muted">—</span>' : esc(ESCALATION_TITLES[escalation])}</td>
        <td class="n">${count}</td>
      </tr>`;
        })
        .join("\n")}
    </tbody>
  </table>
  </div>

  <h2>同类租金基准</h2>
  <div class="note">
    异常租金按 <b>(listingType, propertyType) 分组中位数的比值</b> 判定，而不是全局分位数。
    全局砍尾会误伤 —— 有地住宅整租的中位数本来就是 $${report.cohorts.find((c) => c.listingType === "whole_unit" && c.propertyType === "Landed")?.median.toLocaleString() ?? "—"}。
  </div>
  <div class="scroll">
  <table>
    <thead><tr><th>房型 / 物业</th><th class="n">n</th><th class="n">中位数</th><th class="n">p10</th><th class="n">p90</th></tr></thead>
    <tbody>
      ${report.cohorts
        .map(
          (c) => `<tr>
        <td>${esc(c.listingType)} / ${esc(c.propertyType)}</td>
        <td class="n">${c.n}</td>
        <td class="n">${c.median.toLocaleString()}</td>
        <td class="n">${c.p10.toLocaleString()}</td>
        <td class="n">${c.p90.toLocaleString()}</td>
      </tr>`,
        )
        .join("\n")}
    </tbody>
  </table>
  </div>

  <h2>区域名规范化</h2>
  <div class="note">
    闭集 + 多数票，<b>不手写别名表</b>：按归一键分组，取组内出现频次最高的原始拼写作为 canonical。
    映射从数据自己长出来 —— 这也是为什么不能用 title-case，语料里 <code>one-north</code> 的正确写法就是全小写。
  </div>
  <div class="scroll">
  <table>
    <thead><tr><th>归一键</th><th>组内分布</th><th>canonical</th></tr></thead>
    <tbody>
      ${report.areaCanonicalization
        .map(
          (a) => `<tr>
        <td class="mono">${esc(a.key)}</td>
        <td class="mono muted">${Object.entries(a.variants)
          .map(([v, n]) => `${esc(JSON.stringify(v))} ×${n}`)
          .join(" · ")}</td>
        <td><b>${esc(a.canonical)}</b></td>
      </tr>`,
        )
        .join("\n")}
    </tbody>
  </table>
  </div>

  <h2>全部 issue（${issues.length} 条）</h2>
  <div class="filters">
    <button data-filter="all" aria-pressed="true">全部 ${issues.length}</button>
    ${severityOrder
      .map(
        (s) =>
          `<button data-filter="${s}" aria-pressed="false">${s} ${report.bySeverity[s] ?? 0}</button>`,
      )
      .join("\n    ")}
  </div>
  <div class="scroll">
  <table id="all-issues">
    <thead><tr>
      <th>issueId</th><th>房源</th><th>字段</th><th>规则</th><th>严重度</th>
      <th class="n">原始值</th><th class="n">规范化后</th>
    </tr></thead>
    <tbody>
      ${issues
        .map(
          (i) => `<tr data-severity="${i.severity}">
        <td class="mono muted">${esc(i.issueId)}</td>
        <td class="mono">${esc(i.listingId)}</td>
        <td class="mono muted">${esc(i.field)}</td>
        <td class="mono">${esc(i.rule)}</td>
        <td><span class="tag ${i.severity}">${i.severity}</span></td>
        <td class="n mono">${json(i.raw)}</td>
        <td class="n mono">${i.normalized === undefined ? '<span class="muted">—</span>' : json(i.normalized)}</td>
      </tr>`,
        )
        .join("\n")}
    </tbody>
  </table>
  </div>

  <footer>
    issueId 是 <code>hash(listingId + rule + field)</code>，跨次运行稳定 ——
    两次运行的 issue 集合可以直接做差集，房源库更新时能自动报「新增 N 条 block 级异常」。<br>
    真实生产会把这些 issue 打到 Sentry / Slack webhook，block 级自动开 ticket，
    <code>suggestedFix</code> 进人工审核队列，审核通过才写回主库。
  </footer>

</div>
<script>
  const buttons = document.querySelectorAll(".filters button");
  const rows = document.querySelectorAll("#all-issues tbody tr");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter;
      for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
      for (const row of rows) {
        row.hidden = filter !== "all" && row.dataset.severity !== filter;
      }
    });
  }
</script>
</body>
</html>
`;

const out = join(DATA, "quality-report.html");
writeFileSync(out, html);
const needsHuman = issues.filter((i) => i.escalation !== "none").length;
console.log(
  `报告已生成：data/quality-report.html（${issues.length} 条 issue，其中 ${needsHuman} 条需人工处理）`,
);
