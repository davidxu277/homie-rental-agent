/**
 * 检索引擎的测试。
 *
 *   node --test scripts/search.test.ts
 *
 * 刻意不使用 data/conversations/ 里的任何场景、数值或人设 —— 那 10 个 session 是
 * 留到最后的验收集，不能反过来影响引擎设计。这里测的全是**不变量**：
 * 无论什么查询、什么数据，这些性质都必须成立。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeRelaxations,
  DEFAULT_NOTCHES,
  searchListings,
  type SearchQuery,
} from "../src/lib/search.ts";
import type { CleanListing } from "../src/lib/types.ts";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const listings: CleanListing[] = JSON.parse(
  readFileSync(join(DATA, "listings.clean.json"), "utf8"),
);

// ---------------------------------------------------------------------------
// 合成 fixture —— 单元测试用，与真实数据无关
// ---------------------------------------------------------------------------

let seq = 0;

function makeListing(patch: Partial<CleanListing> = {}): CleanListing {
  seq += 1;
  return {
    id: `TEST${String(seq).padStart(4, "0")}`,
    title: "Test listing",
    propertyType: "HDB",
    listingType: "room",
    roomType: "common_room",
    hdbFlatType: null,
    bedrooms: 1,
    bathrooms: 1,
    sizeSqft: 120,
    district: "D10",
    districtInferred: false,
    area: "Testville",
    address: "1 Test Road",
    nearestMrt: { station: "Test", line: "EWL", walkMinutes: 5 },
    monthlyRentSgd: 1000,
    rentNegotiable: false,
    rentPercentileInCohort: 0.5,
    deposit: { months: 1 },
    leaseMinMonths: 12,
    availableFrom: "2026-09-01",
    isImmediate: false,
    furnishing: "fully",
    utilitiesIncluded: true,
    cookingAllowed: true,
    aircon: true,
    amenities: [],
    petFriendly: false,
    tenantPreferences: { occupantType: "any", maxOccupants: 1, gender: "any", nationality: null },
    directOwner: false,
    agentFee: "half_month",
    imageCount: 3,
    coordinates: { lat: 1.3, lng: 103.8 },
    postedDate: "2026-07-01",
    description: "",
    dataQuality: { flags: [], severity: "ok", isRecommendable: true },
    ...patch,
  };
}

// ===========================================================================
// 硬过滤
// ===========================================================================

describe("硬过滤：结果绝不违反用户给的硬条件", () => {
  it("预算上限是闭区间，超出一元都不返回", () => {
    const pool = [
      makeListing({ monthlyRentSgd: 999 }),
      makeListing({ monthlyRentSgd: 1000 }),
      makeListing({ monthlyRentSgd: 1001 }),
    ];
    const result = searchListings(pool, { budgetMax: 1000 });
    assert.equal(result.total, 2);
    for (const hit of result.hits) {
      assert.ok(hit.listing.monthlyRentSgd! <= 1000);
    }
  });

  it("布尔型必需项在真实数据上永不被违反", () => {
    const cases: Array<[SearchQuery, (l: CleanListing) => boolean]> = [
      [{ requireCooking: true }, (l) => l.cookingAllowed],
      [{ requirePet: true }, (l) => l.petFriendly],
      [{ requireAircon: true }, (l) => l.aircon],
      [{ requireUtilitiesIncluded: true }, (l) => l.utilitiesIncluded],
      [{ directOwnerOnly: true }, (l) => l.directOwner],
    ];
    for (const [query, holds] of cases) {
      const result = searchListings(listings, query, { limit: 1000 });
      assert.ok(result.total > 0, `${JSON.stringify(query)} 不该一条都没有`);
      for (const hit of result.hits) {
        assert.ok(holds(hit.listing), `${hit.listing.id} 违反了 ${JSON.stringify(query)}`);
      }
    }
  });

  // leaseMinMonths 是房源的「最短」租期，短租需求要筛 ≤ 用户能接受的值。
  // 这个方向很容易写反，单独锁一个测试。
  it("短租筛的是最短租期不超过用户上限，不是反过来", () => {
    const pool = [
      makeListing({ leaseMinMonths: 3 }),
      makeListing({ leaseMinMonths: 6 }),
      makeListing({ leaseMinMonths: 12 }),
      makeListing({ leaseMinMonths: 24 }),
    ];
    const result = searchListings(pool, { maxLeaseMinMonths: 6 });
    assert.deepEqual(
      result.hits.map((h) => h.listing.leaseMinMonths).sort((a, b) => a - b),
      [3, 6],
    );
  });

  it("入住日期筛的是「这天之前可入住」", () => {
    const pool = [
      makeListing({ availableFrom: "2026-08-01" }),
      makeListing({ availableFrom: "2026-09-01" }),
      makeListing({ availableFrom: "2026-10-01" }),
    ];
    const result = searchListings(pool, { moveInBy: "2026-09-01" });
    assert.equal(result.total, 2);
  });

  it("地点约束是「或」：area / district / station 命中任一即可", () => {
    const pool = [
      makeListing({ area: "Alpha", district: "D01", nearestMrt: null }),
      makeListing({ area: "Beta", district: "D02", nearestMrt: null }),
      makeListing({
        area: "Gamma",
        district: "D03",
        nearestMrt: { station: "Delta", line: "NSL", walkMinutes: 4 },
      }),
    ];
    assert.equal(searchListings(pool, { areas: ["Alpha"] }).total, 1);
    assert.equal(searchListings(pool, { districts: ["D02"] }).total, 1);
    assert.equal(searchListings(pool, { stations: ["Delta"] }).total, 1);
    assert.equal(searchListings(pool, { areas: ["Alpha"], districts: ["D02"] }).total, 2);
  });

  it("只从可推荐的房源里选", () => {
    const pool = [
      makeListing({ dataQuality: { flags: [], severity: "ok", isRecommendable: true } }),
      makeListing({
        monthlyRentSgd: null,
        dataQuality: { flags: ["rent_zero"], severity: "block", isRecommendable: false },
      }),
    ];
    const result = searchListings(pool, {});
    assert.equal(result.pool, 1);
    assert.equal(result.total, 1);
  });
});

describe("硬过滤：字段缺失不等于不满足", () => {
  // 因为房东漏填一个字段就让用户错过一套合适的房子，是更糟的错误。
  // 放行并在 caveats 里披露，把判断权交回用户。
  it("面积缺失的房源仍能通过面积下限筛选，但会被标注", () => {
    const pool = [
      makeListing({ sizeSqft: null }),
      makeListing({ sizeSqft: 500 }),
      makeListing({ sizeSqft: 1200 }),
    ];
    const result = searchListings(pool, { sizeSqftMin: 900 });
    assert.equal(result.total, 2);
    const missing = result.hits.find((h) => h.listing.sizeSqft === null);
    assert.ok(missing);
    assert.ok(missing.caveats.some((c) => c.includes("面积")));
  });

  it("地铁站缺失的房源仍能通过步行时间筛选，但会被标注", () => {
    const pool = [
      makeListing({ nearestMrt: null }),
      makeListing({ nearestMrt: { station: "Far", line: "EWL", walkMinutes: 25 } }),
    ];
    const result = searchListings(pool, { maxWalkMinutes: 10 });
    assert.equal(result.total, 1);
    assert.ok(result.hits[0].caveats.some((c) => c.includes("地铁")));
  });
});

describe("硬过滤：诊断信息", () => {
  it("每条约束独立计数，能看出是哪个条件卡住了大多数房源", () => {
    const pool = [
      makeListing({ monthlyRentSgd: 5000, cookingAllowed: true }),
      makeListing({ monthlyRentSgd: 5000, cookingAllowed: false }),
      makeListing({ monthlyRentSgd: 800, cookingAllowed: false }),
    ];
    const result = searchListings(pool, { budgetMax: 1000, requireCooking: true });
    assert.equal(result.excludedBy.budgetMax, 2);
    assert.equal(result.excludedBy.requireCooking, 2);
    assert.equal(result.total, 0);
  });
});

// ===========================================================================
// 打分
// ===========================================================================

describe("打分", () => {
  it("总分永远落在 0-1", () => {
    const result = searchListings(listings, { budgetMax: 4000 }, { limit: 1000 });
    for (const hit of result.hits) {
      assert.ok(hit.score >= 0 && hit.score <= 1, `${hit.listing.id} 的分数越界：${hit.score}`);
    }
  });

  it("结果按分数降序，同分按 id —— 同一查询永远得到同样的顺序", () => {
    const query: SearchQuery = { budgetMax: 3000, requireCooking: true };
    const a = searchListings(listings, query, { limit: 50 });
    const b = searchListings(listings, query, { limit: 50 });
    assert.deepEqual(
      a.hits.map((h) => h.listing.id),
      b.hits.map((h) => h.listing.id),
    );
    for (let i = 1; i < a.hits.length; i += 1) {
      assert.ok(a.hits[i - 1].score >= a.hits[i].score, "排序不是降序");
    }
  });

  // 关键：不适用的维度不能被当成"得分 0"，否则数据完整的房源会无端占优，
  // 变相惩罚那些只是漏填了字段的房源。
  it("不适用的维度不参与分母，而不是记 0 分", () => {
    const complete = makeListing({ amenities: ["Gym"] });
    const result = searchListings([complete], {});
    const amenity = result.hits[0].breakdown.find((c) => c.dimension === "amenities");
    assert.equal(amenity?.raw, null, "用户没要求设施时该维度应不适用");

    // 两条房源除「用户未指定的维度」外完全相同，分数必须相同
    const other = makeListing({ amenities: [] });
    const scores = searchListings([complete, other], {}).hits.map((h) => h.score);
    assert.equal(scores[0], scores[1]);
  });

  // 预算是**天花板**不是**目标**。用户说 $1,800，排第一的却是 $650 —— 那恰恰是
  // 这个预算段里最差的房子。在天花板以内，人要的是"能拿到的最好的"。
  it("给了预算时，越贴近预算分越高（不是越便宜越高）", () => {
    const cheap = makeListing({ monthlyRentSgd: 650 });
    const nearBudget = makeListing({ monthlyRentSgd: 1750 });
    const result = searchListings([cheap, nearBudget], { budgetMax: 1800 });
    const fit = (id: string) =>
      result.hits
        .find((h) => h.listing.id === id)!
        .breakdown.find((c) => c.dimension === "budgetFit")!.raw!;

    assert.ok(fit(nearBudget.id) > fit(cheap.id), "$1750 应该比 $650 更贴合 $1800 的预算");
    assert.equal(result.hits[0].listing.id, nearBudget.id, "贴近预算的应该排前面");
  });

  // 用户没表达过对价格的偏好，系统就不该替他假设一个
  it("没给预算时，预算维度完全不参与打分", () => {
    const cheap = makeListing({ monthlyRentSgd: 650 });
    const pricey = makeListing({ monthlyRentSgd: 3000 });
    const result = searchListings([cheap, pricey], {});

    for (const hit of result.hits) {
      const dim = hit.breakdown.find((c) => c.dimension === "budgetFit")!;
      assert.equal(dim.raw, null, "没有预算就没有贴合度可言");
    }
    // 其余维度相同，所以两套分数应该一样 —— 价格不该拉开差距
    assert.equal(result.hits[0].score, result.hits[1].score);
  });

  it("走路更近的房源在通勤维度得分更高", () => {
    const near = makeListing({ nearestMrt: { station: "A", line: "NSL", walkMinutes: 3 } });
    const far = makeListing({ nearestMrt: { station: "B", line: "NSL", walkMinutes: 18 } });
    const result = searchListings([near, far], {});
    const commute = (id: string) =>
      result.hits.find((h) => h.listing.id === id)!.breakdown.find((c) => c.dimension === "commute")!
        .raw!;
    assert.ok(commute(near.id) > commute(far.id));
  });

  // 推荐理由必须能追溯到具体字段，不允许"位置很好""性价比高"这类无来源的形容
  it("每个维度都带可追溯的字段证据", () => {
    const result = searchListings(listings, { budgetMax: 3000 }, { limit: 5 });
    for (const hit of result.hits) {
      for (const component of hit.breakdown) {
        assert.ok(component.evidence.length > 0, `${hit.listing.id} 的 ${component.dimension} 缺证据`);
      }
    }
  });
});

// ===========================================================================
// 披露
// ===========================================================================

describe("披露事项", () => {
  it("房东标注排他性国籍偏好时一定提示", () => {
    const pool = [
      makeListing({
        tenantPreferences: {
          occupantType: "any",
          maxOccupants: 1,
          gender: "any",
          nationality: { raw: "Local/PR only", kind: "exclusive" },
        },
      }),
    ];
    const hit = searchListings(pool, {}).hits[0];
    assert.ok(hit.caveats.some((c) => c.includes("国籍")));
  });

  it("包容性声明不产生警示", () => {
    const pool = [
      makeListing({
        tenantPreferences: {
          occupantType: "any",
          maxOccupants: 1,
          gender: "any",
          nationality: { raw: "Any nationality welcome", kind: "inclusive" },
        },
      }),
    ];
    const hit = searchListings(pool, {}).hits[0];
    assert.ok(!hit.caveats.some((c) => c.includes("国籍")));
  });

  it("推断出来的邮区要标明不是房东填的", () => {
    const pool = [makeListing({ districtInferred: true })];
    assert.ok(searchListings(pool, {}).hits[0].caveats.some((c) => c.includes("推断")));
  });

  it("租金可议是有用信息，会告诉用户", () => {
    const pool = [makeListing({ rentNegotiable: true })];
    assert.ok(searchListings(pool, {}).hits[0].caveats.some((c) => c.includes("可议")));
  });
});

describe("敏感字段", () => {
  // 排他性国籍偏好不是可检索维度 —— 系统上就做不到，而不是靠 prompt 劝阻模型。
  it("引擎根本没有国籍过滤器：传了 tenantNationality 也不改变结果集", () => {
    const withNationality = searchListings(
      listings,
      { budgetMax: 2500, tenantNationality: "Chinese" },
      { limit: 1000 },
    );
    const without = searchListings(listings, { budgetMax: 2500 }, { limit: 1000 });
    assert.equal(withNationality.total, without.total);
    assert.deepEqual(
      withNationality.hits.map((h) => h.listing.id),
      without.hits.map((h) => h.listing.id),
    );
  });

  it("放宽档位表里也没有国籍这一项", () => {
    for (const notch of DEFAULT_NOTCHES) {
      assert.notEqual(notch.key, "tenantNationality");
    }
  });

  // 性别走的是另一条路径：排除会拒绝该租客的房源，是保护而不是筛选室友
  it("性别是保护性筛选：只排除会拒绝该租客的房源", () => {
    const pool = [
      makeListing({
        tenantPreferences: { occupantType: "any", maxOccupants: 1, gender: "female", nationality: null },
      }),
      makeListing({
        tenantPreferences: { occupantType: "any", maxOccupants: 1, gender: "any", nationality: null },
      }),
      makeListing({
        tenantPreferences: { occupantType: "any", maxOccupants: 1, gender: "male", nationality: null },
      }),
    ];
    const result = searchListings(pool, { tenantGender: "male" });
    assert.equal(result.total, 2);
    for (const hit of result.hits) {
      assert.notEqual(hit.listing.tenantPreferences.gender, "female");
    }
  });
});

// ===========================================================================
// 放宽推演
// ===========================================================================

describe("放宽推演", () => {
  const tight: SearchQuery = { budgetMax: 700, sizeSqftMin: 2000, requireCooking: true };

  it("按增量降序，且放宽只会让命中变多、不会变少", () => {
    const relaxations = computeRelaxations(listings, tight);
    assert.ok(relaxations.length > 0);
    for (const r of relaxations) {
      assert.ok(r.delta >= 0, `${r.key} 的增量是负数 —— 放宽不该让结果变少`);
      assert.equal(r.delta, r.hitsAfter - r.hitsBefore);
    }
    for (let i = 1; i < relaxations.length; i += 1) {
      assert.ok(relaxations[i - 1].delta >= relaxations[i].delta, "没有按增量降序");
    }
  });

  // 「所有单档放宽都无济于事」本身是关键信号：冲突是结构性的，不是差一点点。
  // 引擎必须把这个情况和「没有可放宽的约束」区分开，否则调用方该说的话完全不同。
  it("放宽了也没用时仍然返回条目，只是 delta 为 0", () => {
    const impossible: SearchQuery = { budgetMax: 200, sizeSqftMin: 5000 };
    const relaxations = computeRelaxations(listings, impossible);
    assert.ok(relaxations.length > 0, "不该返回空数组 —— 那会和「无约束可放宽」混淆");
    assert.ok(relaxations.every((r) => r.delta === 0));

    const noConstraints = computeRelaxations(listings, {});
    assert.equal(noConstraints.length, 0, "真的没有可放宽的约束时才返回空");
  });

  // 呈现时只讲有增量的那几条，但过滤是调用方的事，不由引擎代劳
  it("调用方可以自行筛出有增量的建议", () => {
    const loose: SearchQuery = { budgetMax: 1200, listingType: "room" };
    const gains = computeRelaxations(listings, loose).filter((r) => r.delta > 0);
    assert.ok(gains.length > 0);
    for (const r of gains) assert.ok(r.hitsAfter > r.hitsBefore);
  });

  it("没被用到的约束不会出现在建议里", () => {
    const relaxations = computeRelaxations(listings, { budgetMax: 700 });
    assert.ok(!relaxations.some((r) => r.key === "sizeSqftMin"));
    assert.ok(!relaxations.some((r) => r.key === "maxLeaseMinMonths"));
  });

  // 用户明确说过"必须"的条件是底线，即使这轮没提也不该被反复试探
  it("keep 里的约束绝不被建议放宽", () => {
    const relaxations = computeRelaxations(listings, tight, { keep: ["budgetMax"] });
    assert.ok(!relaxations.some((r) => r.key === "budgetMax"));
  });

  // 用户说"我最多能到 $1,000"就按 $1,000 算，而不是按 +10% 算
  it("用户给出的幅度优先于档位表", () => {
    const relaxations = computeRelaxations(listings, tight, {
      overrides: { budgetMax: 1500 },
    });
    const budget = relaxations.find((r) => r.key === "budgetMax");
    assert.ok(budget, "应该有预算这一项");

    const expected = searchListings(listings, { ...tight, budgetMax: 1500 }, { limit: 1000 }).total;
    assert.equal(budget.hitsAfter, expected);

    // 同一个约束不该既按用户的值算一遍、又按档位表算一遍
    assert.equal(relaxations.filter((r) => r.key === "budgetMax").length, 1);
  });

  it("档位表的默认幅度和手工放宽一致", () => {
    const relaxations = computeRelaxations(listings, tight);
    const budget = relaxations.find((r) => r.key === "budgetMax");
    if (budget) {
      const manual = searchListings(
        listings,
        { ...tight, budgetMax: Math.round(700 * 1.1) },
        { limit: 1000 },
      ).total;
      assert.equal(budget.hitsAfter, manual);
    }
  });

  it("top 参数能限制条数，避免变成甩清单", () => {
    const all = computeRelaxations(listings, tight);
    const top2 = computeRelaxations(listings, tight, { top: 2 });
    assert.ok(top2.length <= 2);
    assert.deepEqual(top2, all.slice(0, top2.length));
  });

  // 引擎不做地理推断：地点放宽的候选必须由调用方在闭集内解析后传入
  it("不给候选就不会建议放宽地点", () => {
    const withArea: SearchQuery = { ...tight, areas: ["Tampines"] };
    assert.ok(!computeRelaxations(listings, withArea).some((r) => r.key === "areas"));

    const expanded = computeRelaxations(listings, withArea, {
      areaExpansion: ["Bedok", "Pasir Ris"],
    });
    assert.ok(expanded.some((r) => r.key === "areas"));
  });

  it("推演不修改传入的查询", () => {
    const query: SearchQuery = { budgetMax: 700, sizeSqftMin: 2000 };
    const snapshot = JSON.stringify(query);
    computeRelaxations(listings, query, { overrides: { budgetMax: 9000 } });
    assert.equal(JSON.stringify(query), snapshot);
  });
});

// ===========================================================================
// 与真实数据的一致性
// ===========================================================================

describe("真实数据上的一致性", () => {
  it("空查询返回全部可推荐房源", () => {
    const result = searchListings(listings, {}, { limit: 10_000 });
    assert.equal(result.total, listings.filter((l) => l.dataQuality.isRecommendable).length);
  });

  it("约束越多命中越少，永不反增", () => {
    const steps: SearchQuery[] = [
      {},
      { listingType: "room" },
      { listingType: "room", budgetMax: 2000 },
      { listingType: "room", budgetMax: 2000, requireCooking: true },
      { listingType: "room", budgetMax: 2000, requireCooking: true, requireAircon: true },
    ];
    let previous = Number.POSITIVE_INFINITY;
    for (const query of steps) {
      const total = searchListings(listings, query, { limit: 10_000 }).total;
      assert.ok(total <= previous, `加约束后命中反而变多了：${JSON.stringify(query)}`);
      previous = total;
    }
  });

  it("limit 只截断展示，不影响 total", () => {
    const query: SearchQuery = { listingType: "room" };
    const small = searchListings(listings, query, { limit: 3 });
    const large = searchListings(listings, query, { limit: 10_000 });
    assert.equal(small.total, large.total);
    assert.equal(small.hits.length, 3);
  });

  it("推荐结果里不会出现被 block 的房源", () => {
    const result = searchListings(listings, {}, { limit: 10_000 });
    for (const hit of result.hits) {
      assert.equal(hit.listing.dataQuality.severity === "block", false);
      assert.ok(hit.listing.monthlyRentSgd !== null);
    }
  });
});
