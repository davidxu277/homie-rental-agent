/**
 * 清洗管线的测试。
 *
 *   node --test scripts/*.test.ts     （需先跑过 node scripts/clean.ts）
 *
 * 分两层：
 *   1. 解析器的单元测试 —— 包含大量「必须拒绝」的负例，白名单模式的价值全在这里
 *   2. 产出的契约测试 —— 断言清洗结果的不变量，数据源更新后行为变了立刻会红
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  areaKey,
  classifyNationality,
  median,
  parseAvailableFrom,
  parseDeposit,
  parseRent,
  pickCanonicalArea,
  quantile,
  REFERENCE_DATE,
  suggestRentFix,
} from "../src/lib/normalize.ts";
import type { CleanListing, DataIssue, QualityReport } from "../src/lib/types.ts";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

// ===========================================================================
// 1. 解析器
// ===========================================================================

describe("parseRent", () => {
  it("数字原样通过", () => {
    assert.deepEqual(parseRent(1050), { value: 1050, negotiable: false, wasString: false });
  });

  it("认识数据里实际出现的全部四种脏写法", () => {
    assert.equal(parseRent("2,050")?.value, 2050);
    assert.equal(parseRent("6,300")?.value, 6300);
    assert.equal(parseRent("S$1200")?.value, 1200);
    assert.equal(parseRent("S$2250")?.value, 2250);
    assert.equal(parseRent("4400/mo")?.value, 4400);
    assert.equal(parseRent("$5550 negotiable")?.value, 5550);
  });

  it("把 negotiable 当作业务信号保留，而不是丢掉", () => {
    assert.equal(parseRent("$5550 negotiable")?.negotiable, true);
    assert.equal(parseRent("S$1200")?.negotiable, false);
  });

  it("标记出哪些是从字符串解析来的", () => {
    assert.equal(parseRent("S$1200")?.wasString, true);
    assert.equal(parseRent(1200)?.wasString, false);
  });

  // 白名单模式的核心：宁可返回 null 让调用方报 block，也不能猜一个数字出来。
  // 用户按错误价格约看房，产品的信任就没了。
  it("拒绝任何没见过的写法，而不是硬提取数字", () => {
    for (const bad of [
      "约 3500",
      "3500-4000",
      "3.5k",
      "call for price",
      "$3500 per week",
      "3500 SGD",
      "",
      "abc",
    ]) {
      assert.equal(parseRent(bad), null, `不该解析出结果：${JSON.stringify(bad)}`);
    }
  });
});

describe("parseDeposit", () => {
  it("对象原样通过", () => {
    assert.deepEqual(parseDeposit({ months: 2 }), { months: 2 });
  });

  it("认识 '1 month' 这种脏写法", () => {
    assert.deepEqual(parseDeposit("1 month"), { months: 1 });
    assert.deepEqual(parseDeposit("2 months"), { months: 2 });
  });

  it("拒绝没见过的写法", () => {
    for (const bad of ["one month", "1.5 months", "negotiable", ""]) {
      assert.equal(parseDeposit(bad), null, `不该解析出结果：${JSON.stringify(bad)}`);
    }
  });
});

describe("parseAvailableFrom", () => {
  it("ISO 日期原样通过", () => {
    assert.deepEqual(parseAvailableFrom("2026-09-01"), {
      date: "2026-09-01",
      isImmediate: false,
    });
  });

  // 数据里 "Immediate" 和 "immediate" 都有 —— 大小写不统一是真实的坑
  it("大小写不敏感地识别「立即入住」", () => {
    for (const text of ["Immediate", "immediate", "ASAP", "asap", "Now"]) {
      const parsed = parseAvailableFrom(text);
      assert.equal(parsed?.isImmediate, true, `应识别为立即入住：${text}`);
      assert.equal(parsed?.date, REFERENCE_DATE);
    }
  });

  it("拒绝没见过的写法", () => {
    for (const bad of ["Sep 2026", "2026/09/01", "尽快", ""]) {
      assert.equal(parseAvailableFrom(bad), null, `不该解析出结果：${JSON.stringify(bad)}`);
    }
  });
});

describe("区域名规范化", () => {
  it("归一键消除首尾空格和大小写差异", () => {
    assert.equal(areaKey("  toa payoh  "), "toa payoh");
    assert.equal(areaKey("Toa Payoh"), "toa payoh");
    assert.equal(areaKey("Ang  Mo   Kio"), "ang mo kio");
  });

  it("canonical 取组内多数写法", () => {
    const variants = new Map([
      ["Toa Payoh", 8],
      ["  toa payoh  ", 1],
    ]);
    assert.equal(pickCanonicalArea(variants), "Toa Payoh");
  });

  // 语料里 "one-north" 的正确写法就是全小写，title-case 会把它改坏。
  // 多数票法只在数据内部找共识，天然避开这个坑。
  it("不会把 one-north 这类正确的小写名改坏", () => {
    assert.equal(pickCanonicalArea(new Map([["one-north", 12]])), "one-north");
  });
});

describe("classifyNationality", () => {
  it("空值就是没有偏好", () => {
    assert.equal(classifyNationality(null), null);
    assert.equal(classifyNationality("  "), null);
  });

  it("只有明确欢迎所有国籍的才算 inclusive", () => {
    assert.deepEqual(classifyNationality("Any nationality welcome"), {
      raw: "Any nationality welcome",
      kind: "inclusive",
    });
  });

  // 其余一律 exclusive —— 这类偏好不进检索维度，但要保留展示，
  // 房源带国籍限制而用户不符合时主动提示，避免用户白跑一趟。
  it("其余国籍偏好一律视为排他性", () => {
    for (const raw of ["Chinese", "No PRC", "Local/PR only", "Prefer Asian", "Indian"]) {
      assert.equal(classifyNationality(raw)?.kind, "exclusive", `应判为排他性：${raw}`);
    }
  });
});

describe("suggestRentFix", () => {
  it("识别掉了一位数字", () => {
    const fix = suggestRentFix(185, 1950);
    assert.equal(fix?.proposed, 1850);
    assert.equal(fix?.rule, "dropped_digit");
  });

  it("识别多了一位数字", () => {
    const fix = suggestRentFix(62500, 5800);
    assert.equal(fix?.proposed, 6250);
    assert.equal(fix?.rule, "extra_digit");
  });

  it("差得离谱到无法归因时不给建议", () => {
    assert.equal(suggestRentFix(7, 1950), undefined);
    assert.equal(suggestRentFix(0, 1950), undefined);
  });
});

describe("统计小工具", () => {
  it("median 处理奇偶长度", () => {
    assert.equal(median([1, 2, 3]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.ok(Number.isNaN(median([])));
  });

  it("quantile 不越界", () => {
    assert.equal(quantile([1, 2, 3, 4, 5], 0), 1);
    assert.equal(quantile([1, 2, 3, 4, 5], 1), 5);
  });
});

// ===========================================================================
// 2. 产出的契约测试
// ===========================================================================

const listings: CleanListing[] = JSON.parse(
  readFileSync(join(DATA, "listings.clean.json"), "utf8"),
);
const report: QualityReport = JSON.parse(readFileSync(join(DATA, "quality-report.json"), "utf8"));
const issues: DataIssue[] = readFileSync(join(DATA, "quality-issues.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

describe("清洗产出：行数与去重", () => {
  it("502 行输入去重成 500 行", () => {
    assert.equal(report.input.rows, 502);
    assert.equal(listings.length, 500);
  });

  it("恰好抓到 2 组内容完全重复", () => {
    assert.equal(report.duplicates.exactContent.length, 2);
    assert.deepEqual(
      report.duplicates.exactContent.map((d) => d.id).sort(),
      ["SG0121", "SG0474"],
    );
  });

  it("输出里没有重复 id", () => {
    assert.equal(new Set(listings.map((l) => l.id)).size, listings.length);
  });
});

describe("清洗产出：类型收紧", () => {
  it("租金要么是数字要么是 null，不再有字符串", () => {
    for (const l of listings) {
      assert.ok(
        l.monthlyRentSgd === null || typeof l.monthlyRentSgd === "number",
        `${l.id} 的租金类型不对`,
      );
    }
  });

  it("押金要么是 { months } 要么是 null", () => {
    for (const l of listings) {
      assert.ok(l.deposit === null || typeof l.deposit.months === "number", `${l.id} 的押金类型不对`);
    }
  });

  it("入住日期全部是 YYYY-MM-DD", () => {
    for (const l of listings) {
      assert.match(l.availableFrom, /^\d{4}-\d{2}-\d{2}$/, `${l.id} 的入住日期没规范化`);
    }
  });

  it("区域名没有首尾空格，且收敛到 46 个", () => {
    for (const l of listings) {
      assert.equal(l.area, l.area.trim(), `${l.id} 的区域名还有空格`);
    }
    assert.equal(new Set(listings.map((l) => l.area)).size, 46);
  });

  it("单间房源的 bedrooms 都被纠正为 1", () => {
    for (const l of listings.filter((x) => x.listingType === "room")) {
      assert.equal(l.bedrooms, 1, `${l.id} 是单间但 bedrooms 不是 1`);
    }
  });
});

describe("清洗产出：脏数据每类恰好 6 条", () => {
  const expected: Record<string, number> = {
    rent_format_string: 6,
    available_from_text: 6,
    deposit_format_string: 6,
    mrt_missing: 6,
    district_missing: 6,
    size_missing: 6,
    bedrooms_contradiction: 6,
    area_normalized: 6,
  };

  for (const [rule, count] of Object.entries(expected)) {
    it(`${rule} = ${count}`, () => {
      assert.equal(report.byRule[rule], count);
    });
  }

  it("租金异常合计 6 条（2 个零值 + 3 个掉零 + 1 个多零）", () => {
    const total =
      (report.byRule.rent_zero ?? 0) +
      (report.byRule.rent_outlier_low ?? 0) +
      (report.byRule.rent_outlier_high ?? 0);
    assert.equal(total, 6);
  });

  it("没有任何解析失败 —— 白名单已覆盖数据里的全部格式", () => {
    assert.equal(report.byRule.rent_unparseable ?? 0, 0);
    assert.equal(report.byRule.deposit_unparseable ?? 0, 0);
    assert.equal(report.byRule.available_from_unparseable ?? 0, 0);
  });

  it("没有意料之外的规则出现", () => {
    const known = new Set([
      ...Object.keys(expected),
      "rent_zero",
      "rent_outlier_low",
      "rent_outlier_high",
      "duplicate_exact",
    ]);
    for (const rule of Object.keys(report.byRule)) {
      assert.ok(known.has(rule), `出现了未登记的规则：${rule}`);
    }
  });
});

describe("清洗产出：推荐池", () => {
  it("494 条可推荐，6 条被 block 挡在外面", () => {
    const recommendable = listings.filter((l) => l.dataQuality.isRecommendable);
    assert.equal(recommendable.length, 494);
    assert.equal(report.output.recommendable, 494);
  });

  it("可推荐的房源租金一定 > 0", () => {
    for (const l of listings.filter((x) => x.dataQuality.isRecommendable)) {
      assert.ok((l.monthlyRentSgd ?? 0) > 0, `${l.id} 进了推荐池但租金不可用`);
    }
  });

  // 重复行的 issue 用的是同一个 id，如果不排除，被保留的那条会被误判为不可推荐
  it("去重不会误伤被保留的那一行", () => {
    for (const id of ["SG0121", "SG0474"]) {
      const kept = listings.find((l) => l.id === id);
      assert.ok(kept, `${id} 应该被保留`);
      assert.equal(kept.dataQuality.isRecommendable, true, `${id} 被去重误伤了`);
    }
  });

  it("warn 级问题不影响推荐，只要求 agent 披露", () => {
    const warnOnly = listings.filter((l) => l.dataQuality.severity === "warn");
    assert.ok(warnOnly.length > 0);
    for (const l of warnOnly) {
      assert.equal(l.dataQuality.isRecommendable, true, `${l.id} 因 warn 被错误排除`);
    }
  });
});

describe("清洗产出：修复建议只进报告", () => {
  it("掉零的房源给出了乘 10 的建议，但业务字段没被改写", () => {
    for (const id of ["SG0173", "SG0395", "SG0400"]) {
      const issue = issues.find((i) => i.listingId === id && i.rule === "rent_outlier_low");
      assert.ok(issue?.suggestedFix, `${id} 应该有修复建议`);
      assert.equal(issue.suggestedFix.rule, "dropped_digit");
      assert.equal(issue.suggestedFix.proposed, (issue.raw as number) * 10);

      // 关键：建议归建议，业务字段必须仍然是 null（而不是被写成建议值）
      const listing = listings.find((l) => l.id === id);
      assert.equal(listing?.monthlyRentSgd, null, `${id} 的租金被自动改写了`);
    }
  });

  it("零值给不出建议，只能排除", () => {
    for (const id of ["SG0009", "SG0308"]) {
      const issue = issues.find((i) => i.listingId === id && i.rule === "rent_zero");
      assert.ok(issue);
      assert.equal(issue.suggestedFix, undefined);
    }
  });
});

describe("清洗产出：escalation 与 severity 正交", () => {
  it("每条 issue 都登记了处理方", () => {
    for (const i of issues) {
      assert.ok(
        ["none", "ops_review", "source_followup"].includes(i.escalation),
        `${i.rule} 的 escalation 不合法：${i.escalation}`,
      );
    }
  });

  // 缺面积在产品上只需 warn（照常推荐 + 披露），但运维上确实该有人去追。
  // 这正是 severity 和 escalation 不能合并的理由。
  it("warn 级的缺失字段仍然会派给人处理", () => {
    for (const rule of ["size_missing", "mrt_missing"]) {
      const sample = issues.find((i) => i.rule === rule);
      assert.ok(sample, `应该有 ${rule} 的 issue`);
      assert.equal(sample.severity, "warn", `${rule} 在产品上不该阻断`);
      assert.notEqual(sample.escalation, "none", `${rule} 不该无人过问`);
    }
  });

  // 分队列的依据是「这个字段在检索里的地位」：
  // 硬过滤字段缺失会让用户看到不该看到的房源（结果变错），软打分字段缺失只是少个加分项。
  it("硬过滤字段的问题优先级更高，进运维审核", () => {
    // 面积参与 sizeSqftMin 硬过滤，缺失时按「缺失≠不满足」放行 —— 结果会变错
    assert.equal(issues.find((i) => i.rule === "size_missing")?.escalation, "ops_review");
    // 价格是最核心的硬过滤字段
    assert.equal(issues.find((i) => i.rule === "rent_outlier_low")?.escalation, "ops_review");
    // bedrooms 参与 bedroomsMin 硬过滤；字段自相矛盾本身也说明该房源其他字段可能不可信
    assert.equal(issues.find((i) => i.rule === "bedrooms_contradiction")?.escalation, "ops_review");
  });

  it("只影响软打分的问题走低优先级队列", () => {
    // 地铁站只进通勤打分维度，缺了不会让任何结果变错
    assert.equal(issues.find((i) => i.rule === "mrt_missing")?.escalation, "source_followup");
  });

  it("info 级的格式问题不打扰任何人", () => {
    for (const rule of ["rent_format_string", "deposit_format_string", "area_normalized"]) {
      const sample = issues.find((i) => i.rule === rule);
      assert.equal(sample?.escalation, "none", `${rule} 不该派给人`);
    }
  });

  it("有修复建议的一定进运维审核队列", () => {
    for (const i of issues.filter((x) => x.suggestedFix)) {
      assert.equal(i.escalation, "ops_review", `${i.listingId} 有修复建议却没进审核队列`);
    }
  });

  it("两个轴的计数各自自洽", () => {
    const sum = (counts: Record<string, number>) =>
      Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(sum(report.bySeverity), issues.length);
    assert.equal(sum(report.byEscalation), issues.length);
  });
});

describe("清洗产出：issueId 稳定可 diff", () => {
  it("每条 issue 的 id 唯一", () => {
    assert.equal(new Set(issues.map((i) => i.issueId)).size, issues.length);
  });

  it("issueId 只由 listingId + rule + field 决定，与运行时间无关", () => {
    // 同一条数据的同一个问题跨次运行必须得到同一个 id，
    // 否则两次运行的 issue 集合无法做差集，回归检测就失效了
    const sample = issues[0];
    const same = issues.filter(
      (i) =>
        i.listingId === sample.listingId && i.rule === sample.rule && i.field === sample.field,
    );
    assert.ok(same.every((i) => i.issueId === sample.issueId));
  });
});

describe("清洗产出：派生字段", () => {
  it("价格分位落在 0-1 之间", () => {
    for (const l of listings.filter((x) => x.rentPercentileInCohort !== null)) {
      assert.ok(
        l.rentPercentileInCohort! >= 0 && l.rentPercentileInCohort! <= 1,
        `${l.id} 的价格分位越界`,
      );
    }
  });

  it("不可推荐的房源没有价格分位", () => {
    for (const l of listings.filter((x) => !x.dataQuality.isRecommendable)) {
      assert.equal(l.rentPercentileInCohort, null, `${l.id} 不该有价格分位`);
    }
  });

  it("同类分组覆盖了全部 7 种组合", () => {
    assert.equal(report.cohorts.length, 7);
    for (const c of report.cohorts) {
      assert.ok(c.n > 0 && c.median > 0, `${c.listingType}/${c.propertyType} 的基准不对`);
    }
  });

  it("立即入住的房源日期落到参考日", () => {
    for (const l of listings.filter((x) => x.isImmediate)) {
      assert.equal(l.availableFrom, REFERENCE_DATE);
    }
  });

  // 数据字典明说坐标是合成的，拿合成坐标反推"最近地铁站"是精确的假数据
  it("缺失的地铁站保持为 null，不用坐标反推", () => {
    const missing = listings.filter((l) => l.nearestMrt === null);
    assert.equal(missing.length, 6);
    for (const l of missing) {
      assert.ok(l.dataQuality.flags.includes("mrt_missing"), `${l.id} 缺站点但没打标记`);
    }
  });

  it("缺失的面积保持为 null，不做插值", () => {
    assert.equal(listings.filter((l) => l.sizeSqft === null).length, 6);
  });
});
