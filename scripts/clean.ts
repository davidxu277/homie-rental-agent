/**
 * 离线数据清洗管线。
 *
 *   node scripts/clean.ts
 *
 * 读 data/listings.json，产出三个文件：
 *   data/listings.clean.json    —— 检索层唯一的数据源
 *   data/quality-report.json    —— 汇总，喂给 scripts/report.ts
 *   data/quality-issues.jsonl   —— 逐条 issue，一行一个，便于 diff 和导入
 *
 * 设计原则：
 *   1. 一次性离线跑完，运行时不再碰原始数据 —— 清洗成本为零、可复现、可测试。
 *   2. 不静默丢弃任何一行。所有问题都上报为结构化 issue，按严重度决定产品行为。
 *   3. 不猜。缺失就是缺失，异常就是异常，修复建议只进报告不写回业务字段。
 *   4. 白名单模式：遇到没预料的格式就报错退出，而不是静默返回一个错误的值。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Cohort,
  CleanListing,
  DataIssue,
  Escalation,
  ListingType,
  PropertyType,
  QualityReport,
  RawListing,
  Severity,
} from "../src/lib/types.ts";
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
  RENT_RATIO_MAX,
  RENT_RATIO_MIN,
  suggestRentFix,
  type RentParse,
} from "../src/lib/normalize.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");

// ===========================================================================
// issue 收集
// ===========================================================================

const issues: DataIssue[] = [];
const DETECTED_AT = new Date().toISOString();

/**
 * 每条规则该由谁处理 —— 和 severity 正交，见 types.ts 里 Escalation 的说明。
 *
 * 判断标准是**这个字段在检索里的地位**，而不是"我们修不修得了"：
 *
 *   ops_review      影响硬过滤 —— 缺了或错了会让用户看到不该看到的房源，必须主动追
 *   source_followup 只影响软打分 —— 缺了只是少一个加分维度，不会让结果变错，低优先补齐
 *   none            清洗阶段已处理干净，无需任何人介入
 *
 * 之所以不按"我们修不修得了"分：房东不看我们的工单，所有 ticket 最后都落在运营桌上，
 * 由运营决定要不要去联系房源方。按能否自修来分队列，是个假的区分。
 */
const RULE_ESCALATION: Record<string, Escalation> = {
  // 价格是最核心的硬过滤字段，同类中位数已给出明确的修复建议，等人审核通过即可
  rent_outlier_low: "ops_review",
  rent_outlier_high: "ops_review",
  // 无法归因，但必须有人决定这两条怎么办（下架？联系房东？）
  rent_zero: "ops_review",
  // feed 的结构性缺陷，该修的是上游管道而不是这一行数据
  duplicate_exact: "ops_review",
  // 白名单没覆盖到的新格式 —— 一旦出现就必须有人来看
  rent_unparseable: "ops_review",
  deposit_unparseable: "ops_review",
  available_from_unparseable: "ops_review",
  // 面积是硬过滤字段。缺失时检索层按「缺失≠不满足」放行，用户可能看到根本不符合
  // 面积要求的房源 —— 这是会让结果变错的，必须主动追房东补齐
  size_missing: "ops_review",
  // bedrooms 同样参与硬过滤（bedroomsMin）。虽然已按 listingType 纠正、结果不会错，
  // 但源头存在自相矛盾的字段本身就是信号 —— 同一条房源的其他字段也可能不可信
  bedrooms_contradiction: "ops_review",

  // 只影响软打分：缺了只是少一个通勤加分维度，不会让任何结果变错
  mrt_missing: "source_followup",

  // 已自动处理干净，无需任何人介入
  district_missing: "none", // 由同 area 众数可靠回填
  area_normalized: "none",
  rent_format_string: "none",
  deposit_format_string: "none",
  available_from_text: "none",
};

type IssueInput = {
  listingId: string;
  rule: string;
  field: string;
  severity: Severity;
  raw: unknown;
  normalized?: unknown;
  suggestedFix?: DataIssue["suggestedFix"];
  evidence?: string;
};

function report(input: IssueInput): void {
  const escalation = RULE_ESCALATION[input.rule];
  if (escalation === undefined) {
    // 新增规则时忘了登记，会在这里立刻炸掉 —— 而不是悄悄漏掉一批本该有人处理的问题
    throw new Error(`规则 "${input.rule}" 没有登记 escalation，请在 RULE_ESCALATION 里补上`);
  }

  issues.push({
    // 稳定哈希：同一条数据的同一个问题，跨次运行 issueId 不变。
    // 两次运行的 issue 集合可以直接做差集 —— 房源库更新时能自动报"新增 N 条 block 级异常"。
    issueId: createHash("sha1")
      .update(`${input.listingId}|${input.rule}|${input.field}`)
      .digest("hex")
      .slice(0, 12),
    listingId: input.listingId,
    rule: input.rule,
    field: input.field,
    severity: input.severity,
    escalation,
    raw: input.raw,
    ...(input.normalized !== undefined ? { normalized: input.normalized } : {}),
    ...(input.suggestedFix ? { suggestedFix: input.suggestedFix } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    detectedAt: DETECTED_AT,
  });
}

// ===========================================================================
// 小工具
// ===========================================================================

function cohortKey(listingType: ListingType, propertyType: PropertyType): string {
  return `${listingType}|${propertyType}`;
}

// ===========================================================================
// Pass 0 —— 载入与去重
// ===========================================================================

const rawRows: RawListing[] = JSON.parse(readFileSync(join(DATA, "listings.json"), "utf8"));

const seenContent = new Map<string, number>();
const kept: RawListing[] = [];
const exactDuplicates: QualityReport["duplicates"]["exactContent"] = [];

rawRows.forEach((row, index) => {
  // 按"全字段规范化后的 JSON"做内容哈希 —— 比只看 id 更严格，
  // 既能抓到 id 重复，也能抓到 id 不同但内容完全一致的情况
  const fingerprint = createHash("sha1")
    .update(JSON.stringify(row, Object.keys(row).sort()))
    .digest("hex");

  const firstIndex = seenContent.get(fingerprint);
  if (firstIndex !== undefined) {
    exactDuplicates.push({ id: row.id, keptIndex: firstIndex, droppedIndex: index });
    report({
      listingId: row.id,
      rule: "duplicate_exact",
      field: "*",
      severity: "block",
      raw: `row #${index}`,
      evidence: `与 row #${firstIndex} 内容完全一致（含 id），已丢弃后者`,
    });
    return;
  }
  seenContent.set(fingerprint, index);
  kept.push(row);
});

// ===========================================================================
// Pass 1 —— 逐行解析标量，先不做任何需要全局视野的判断
// ===========================================================================

type Parsed = {
  row: RawListing;
  rent: RentParse | null;
  deposit: { months: number } | null;
  available: { date: string; isImmediate: boolean } | null;
  key: string;
};

const parsed: Parsed[] = kept.map((row) => {
  const rent = parseRent(row.monthlyRentSgd);
  if (rent === null) {
    report({
      listingId: row.id,
      rule: "rent_unparseable",
      field: "monthlyRentSgd",
      severity: "block",
      raw: row.monthlyRentSgd,
      evidence: "不匹配任何已知租金写法",
    });
  } else if (rent.wasString) {
    report({
      listingId: row.id,
      rule: "rent_format_string",
      field: "monthlyRentSgd",
      severity: "info",
      raw: row.monthlyRentSgd,
      normalized: rent.negotiable ? { value: rent.value, negotiable: true } : rent.value,
    });
  }

  const deposit = parseDeposit(row.deposit);
  if (deposit === null) {
    report({
      listingId: row.id,
      rule: "deposit_unparseable",
      field: "deposit",
      severity: "block",
      raw: row.deposit,
      evidence: "不匹配 { months: n } 也不匹配 'n month(s)'",
    });
  } else if (typeof row.deposit === "string") {
    report({
      listingId: row.id,
      rule: "deposit_format_string",
      field: "deposit",
      severity: "info",
      raw: row.deposit,
      normalized: deposit,
    });
  }

  const available = parseAvailableFrom(row.availableFrom);
  if (available === null) {
    report({
      listingId: row.id,
      rule: "available_from_unparseable",
      field: "availableFrom",
      severity: "block",
      raw: row.availableFrom,
    });
  } else if (available.isImmediate) {
    report({
      listingId: row.id,
      rule: "available_from_text",
      field: "availableFrom",
      severity: "info",
      raw: row.availableFrom,
      normalized: available.date,
      evidence: `落到参考日期 ${REFERENCE_DATE}`,
    });
  }

  return { row, rent, deposit, available, key: areaKey(row.area) };
});

// ===========================================================================
// Pass 2 —— 需要全局视野的两件事：区域名规范化、同类租金基准
// ===========================================================================

/**
 * 区域名规范化：闭集 + 多数票，不手写别名表。
 *
 * 按归一键分组，取组内出现频次最高的原始拼写作为 canonical。映射从数据自己长出来，
 * 不引入任何外部规则 —— 这也是为什么绝对不能用 title-case：语料里 "one-north" 的
 * 正确写法就是全小写，无脑 title-case 会把它改坏。
 */
const areaGroups = new Map<string, Map<string, number>>();
for (const { row, key } of parsed) {
  const variants = areaGroups.get(key) ?? new Map<string, number>();
  variants.set(row.area, (variants.get(row.area) ?? 0) + 1);
  areaGroups.set(key, variants);
}

const areaCanonical = new Map<string, string>();
const areaReport: QualityReport["areaCanonicalization"] = [];

for (const [key, variants] of areaGroups) {
  const canonical = pickCanonicalArea(variants);

  // 兜底：若组内只有脏写法、没有干净对照，说明这个区域名从未以规范形式出现过。
  // 这时该由人看一眼，而不是让脚本猜 —— 直接报错退出。
  if (canonical !== canonical.trim().replace(/\s+/g, " ")) {
    throw new Error(
      `区域名 "${key}" 的所有写法都是脏的（${[...variants.keys()].map((v) => JSON.stringify(v)).join(", ")}），` +
        `没有干净对照可以作为 canonical，需要人工确认`,
    );
  }

  areaCanonical.set(key, canonical);
  if (variants.size > 1) {
    areaReport.push({ key, canonical, variants: Object.fromEntries(variants) });
  }
}

/** 同类租金基准。排掉 0 值（明显无效），中位数对剩余异常值本身是稳健的 */
const cohortRents = new Map<string, number[]>();
for (const { row, rent } of parsed) {
  if (rent === null || rent.value <= 0) continue;
  const key = cohortKey(row.listingType, row.propertyType);
  const list = cohortRents.get(key) ?? [];
  list.push(rent.value);
  cohortRents.set(key, list);
}

const cohorts = new Map<string, Cohort>();
for (const [key, list] of cohortRents) {
  const sorted = [...list].sort((a, b) => a - b);
  const [listingType, propertyType] = key.split("|");
  cohorts.set(key, {
    listingType: listingType as ListingType,
    propertyType: propertyType as PropertyType,
    n: sorted.length,
    median: median(sorted),
    p10: quantile(sorted, 0.1),
    p90: quantile(sorted, 0.9),
  });
}

/** district 回填：纯粹用 area 在数据内部的共现关系，不引入任何外部地理知识 */
const districtByArea = new Map<string, Map<string, number>>();
for (const { row, key } of parsed) {
  if (!row.district) continue;
  const counts = districtByArea.get(key) ?? new Map<string, number>();
  counts.set(row.district, (counts.get(row.district) ?? 0) + 1);
  districtByArea.set(key, counts);
}

function inferDistrict(key: string): string | null {
  const counts = districtByArea.get(key);
  if (!counts || counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ===========================================================================
// Pass 3 —— 应用规范化、判定异常、产出 CleanListing
// ===========================================================================

/**
 * 这些规则描述的是"已经被整行移除"的问题，不该再算到幸存那一行头上。
 * 重复行的 issue 用的是同一个 id，如果不排除，被保留的那条也会被误判为不可推荐。
 */
const ROW_REMOVED_RULES = new Set(["duplicate_exact"]);

const clean: CleanListing[] = parsed.map(({ row, rent, deposit, available, key }) => {
  const id = row.id;
  const cohort = cohorts.get(cohortKey(row.listingType, row.propertyType));

  // --- 租金异常：按同类中位数比值判定，而不是全局分位数 ---------------------
  // 全局砍尾会误伤：有地住宅整租的中位数本来就是 $15,600，最高 $24,350 完全合法。
  let rentValue: number | null = rent?.value ?? null;

  if (rent !== null && cohort) {
    if (rent.value === 0) {
      report({
        listingId: id,
        rule: "rent_zero",
        field: "monthlyRentSgd",
        severity: "block",
        raw: row.monthlyRentSgd,
        evidence: "租金为 0，无法推断真实价格",
      });
      rentValue = null;
    } else {
      const ratio = rent.value / cohort.median;
      if (ratio < RENT_RATIO_MIN || ratio > RENT_RATIO_MAX) {
        report({
          listingId: id,
          rule: ratio < RENT_RATIO_MIN ? "rent_outlier_low" : "rent_outlier_high",
          field: "monthlyRentSgd",
          severity: "block",
          raw: rent.value,
          suggestedFix: suggestRentFix(rent.value, cohort.median),
          evidence:
            `同类（${row.listingType} / ${row.propertyType}, n=${cohort.n}）中位数 ` +
            `${cohort.median}，比值 ${ratio.toFixed(2)}`,
        });
        rentValue = null;
      }
    }
  }

  // --- 缺失字段：标记，不猜 -------------------------------------------------
  if (row.sizeSqft === null) {
    report({
      listingId: id,
      rule: "size_missing",
      field: "sizeSqft",
      severity: "warn",
      raw: null,
      evidence: "面积未提供；用户明确要求面积时该房源不参与筛选",
    });
  }

  if (row.nearestMrt === null) {
    // 刻意不用 coordinates 反推最近站点：数据字典明说坐标是合成的，
    // 拿合成坐标推出来的"最近地铁站"是精确的假数据。缺就是缺，由 agent 如实披露。
    report({
      listingId: id,
      rule: "mrt_missing",
      field: "nearestMrt",
      severity: "warn",
      raw: null,
      evidence: "最近地铁站未提供；不用合成坐标反推",
    });
  }

  let district = row.district && row.district.trim() !== "" ? row.district : null;
  let districtInferred = false;
  if (district === null) {
    const guess = inferDistrict(key);
    if (guess !== null) {
      district = guess;
      districtInferred = true;
    }
    report({
      listingId: id,
      rule: "district_missing",
      field: "district",
      severity: "warn",
      raw: row.district,
      normalized: district,
      evidence:
        guess !== null
          ? `由同 area（${areaCanonical.get(key)}）的其他房源众数回填`
          : "同 area 没有可参照的房源，保持为空",
    });
  }

  // --- 字段矛盾：以 listingType 为准（更可信），记录矛盾 --------------------
  let bedrooms = row.bedrooms;
  if (row.listingType === "room" && row.bedrooms > 1) {
    report({
      listingId: id,
      rule: "bedrooms_contradiction",
      field: "bedrooms",
      severity: "warn",
      raw: row.bedrooms,
      normalized: 1,
      evidence: "listingType 为 room 但 bedrooms > 1，以 listingType 为准",
    });
    bedrooms = 1;
  }

  // --- 区域名规范化 ---------------------------------------------------------
  const area = areaCanonical.get(key) ?? row.area;
  if (area !== row.area) {
    report({
      listingId: id,
      rule: "area_normalized",
      field: "area",
      severity: "info",
      raw: row.area,
      normalized: area,
      evidence: `归一键 "${key}" 组内多数写法`,
    });
  }

  return {
    id,
    title: row.title,
    propertyType: row.propertyType,
    listingType: row.listingType,
    roomType: row.roomType,
    hdbFlatType: row.hdbFlatType,
    bedrooms,
    bathrooms: row.bathrooms,
    sizeSqft: row.sizeSqft,
    district,
    districtInferred,
    area,
    address: row.address,
    nearestMrt: row.nearestMrt,

    monthlyRentSgd: rentValue,
    rentNegotiable: rent?.negotiable ?? false,
    rentPercentileInCohort: null, // Pass 4 填

    deposit,
    leaseMinMonths: row.leaseMinMonths,
    availableFrom: available?.date ?? row.availableFrom,
    isImmediate: available?.isImmediate ?? false,

    furnishing: row.furnishing,
    utilitiesIncluded: row.utilitiesIncluded,
    cookingAllowed: row.cookingAllowed,
    aircon: row.aircon,
    amenities: row.amenities,
    petFriendly: row.petFriendly,

    tenantPreferences: {
      occupantType: row.tenantPreferences.occupantType,
      maxOccupants: row.tenantPreferences.maxOccupants,
      gender: row.tenantPreferences.gender,
      nationality: classifyNationality(row.tenantPreferences.nationality),
    },

    directOwner: row.directOwner,
    agentFee: row.agentFee,
    imageCount: row.imageCount,
    coordinates: row.coordinates,
    postedDate: row.postedDate,
    description: row.description,

    // Pass 4 填 —— 此时 issue 还没收集完，不能在这里判定
    dataQuality: { flags: [], severity: "ok", isRecommendable: true },
  };
});

// ===========================================================================
// Pass 4 —— issue 全部收集完毕，才能回填每条房源的质量结论
// ===========================================================================

const issuesByListing = new Map<string, DataIssue[]>();
for (const issue of issues) {
  if (ROW_REMOVED_RULES.has(issue.rule)) continue;
  const list = issuesByListing.get(issue.listingId) ?? [];
  list.push(issue);
  issuesByListing.set(issue.listingId, list);
}

for (const listing of clean) {
  const mine = issuesByListing.get(listing.id) ?? [];
  const hasBlock = mine.some((i) => i.severity === "block");
  const hasWarn = mine.some((i) => i.severity === "warn");

  listing.dataQuality = {
    flags: mine.map((i) => i.rule),
    severity: mine.length === 0 ? "ok" : hasBlock ? "block" : hasWarn ? "warn" : "info",
    // 租金不可用的房源一律不推荐 —— 没有价格就没法谈匹配
    isRecommendable: !hasBlock && listing.monthlyRentSgd !== null,
  };
}

// ===========================================================================
// Pass 5 —— 价格分位（只在可推荐的房源之间算，异常值不该影响分位）
// ===========================================================================

const percentilePool = new Map<string, number[]>();
for (const listing of clean) {
  if (!listing.dataQuality.isRecommendable || listing.monthlyRentSgd === null) continue;
  const key = cohortKey(listing.listingType, listing.propertyType);
  const list = percentilePool.get(key) ?? [];
  list.push(listing.monthlyRentSgd);
  percentilePool.set(key, list);
}

for (const [key, list] of percentilePool) {
  list.sort((a, b) => a - b);
  percentilePool.set(key, list);
}

for (const listing of clean) {
  if (!listing.dataQuality.isRecommendable || listing.monthlyRentSgd === null) continue;
  const pool = percentilePool.get(cohortKey(listing.listingType, listing.propertyType));
  if (!pool || pool.length === 0) continue;
  const below = pool.filter((r) => r < listing.monthlyRentSgd!).length;
  listing.rentPercentileInCohort = Number((below / pool.length).toFixed(3));
}

// ===========================================================================
// 产出
// ===========================================================================

const bySeverity: Record<string, number> = { block: 0, warn: 0, info: 0 };
const byEscalation: Record<string, number> = { ops_review: 0, source_followup: 0, none: 0 };
const byRule: Record<string, number> = {};
for (const issue of issues) {
  bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
  byEscalation[issue.escalation] = (byEscalation[issue.escalation] ?? 0) + 1;
  byRule[issue.rule] = (byRule[issue.rule] ?? 0) + 1;
}

const recommendable = clean.filter((l) => l.dataQuality.isRecommendable).length;

const report_: QualityReport = {
  generatedAt: DETECTED_AT,
  referenceDate: REFERENCE_DATE,
  input: { rows: rawRows.length },
  output: { rows: clean.length, recommendable, excluded: clean.length - recommendable },
  duplicates: { exactContent: exactDuplicates },
  bySeverity,
  byEscalation,
  byRule: Object.fromEntries(Object.entries(byRule).sort((a, b) => b[1] - a[1])),
  cohorts: [...cohorts.values()].sort(
    (a, b) => a.listingType.localeCompare(b.listingType) || a.propertyType.localeCompare(b.propertyType),
  ),
  areaCanonicalization: areaReport.sort((a, b) => a.key.localeCompare(b.key)),
};

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, "listings.clean.json"), `${JSON.stringify(clean, null, 2)}\n`);
writeFileSync(join(DATA, "quality-report.json"), `${JSON.stringify(report_, null, 2)}\n`);
writeFileSync(
  join(DATA, "quality-issues.jsonl"),
  `${issues.map((i) => JSON.stringify(i)).join("\n")}\n`,
);

// ===========================================================================
// 不变量断言 —— 任何一条不成立就非零退出，让 CI 变红
// ===========================================================================

const invariants: Array<[string, boolean]> = [
  ["输入 502 行", rawRows.length === 502],
  ["去重后 500 行", clean.length === 500],
  ["恰好 2 组内容完全重复", exactDuplicates.length === 2],
  ["所有租金要么是数字要么为 null", clean.every((l) => l.monthlyRentSgd === null || typeof l.monthlyRentSgd === "number")],
  ["没有租金解析失败（白名单已覆盖全部格式）", (byRule["rent_unparseable"] ?? 0) === 0],
  ["没有押金解析失败", (byRule["deposit_unparseable"] ?? 0) === 0],
  ["没有入住日解析失败", (byRule["available_from_unparseable"] ?? 0) === 0],
  ["区域名全部规范化（无首尾空格）", clean.every((l) => l.area === l.area.trim())],
  ["room 类型的 bedrooms 都是 1", clean.every((l) => l.listingType !== "room" || l.bedrooms === 1)],
  ["可推荐房源的租金都 > 0", clean.every((l) => !l.dataQuality.isRecommendable || (l.monthlyRentSgd ?? 0) > 0)],
];

const failed = invariants.filter(([, ok]) => !ok);

console.log(`\n输入 ${rawRows.length} 行 → 输出 ${clean.length} 行，其中 ${recommendable} 条可推荐\n`);
console.log(`issue 共 ${issues.length} 条：block ${bySeverity.block} · warn ${bySeverity.warn} · info ${bySeverity.info}`);
console.log(
  `需人工处理 ${byEscalation.ops_review + byEscalation.source_followup} 条：` +
    `运维审核 ${byEscalation.ops_review} · 回访房源方 ${byEscalation.source_followup}` +
    `（另有 ${byEscalation.none} 条已自动处理）\n`,
);
for (const [rule, count] of Object.entries(report_.byRule)) {
  console.log(`  ${rule.padEnd(28)} ${String(count).padStart(3)}`);
}
console.log("");

if (failed.length > 0) {
  console.error("不变量断言失败：");
  for (const [name] of failed) console.error(`  ✗ ${name}`);
  process.exit(1);
}
console.log(`${invariants.length} 条不变量断言全部通过`);
console.log("产出：data/listings.clean.json · data/quality-report.json · data/quality-issues.jsonl\n");
