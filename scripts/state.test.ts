/**
 * 对话状态的测试。
 *
 *   node --test scripts/state.test.ts
 *
 * 同样不使用 data/conversations/ 里的任何场景 —— 测的是状态机的不变量：
 * 无论对话怎么走，这些性质都必须成立。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { computeRelaxations, searchListings } from "../src/lib/search.ts";
import {
  applyPatch,
  clarifyingQuestion,
  constraintCount,
  emptyState,
  needsClarification,
  pinnedSlots,
  slotsChangedOnTurn,
  toSearchQuery,
  unconfirmedSlots,
  type RequirementState,
  type StatePatch,
} from "../src/lib/state.ts";
import type { CleanListing } from "../src/lib/types.ts";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const listings: CleanListing[] = JSON.parse(
  readFileSync(join(DATA, "listings.clean.json"), "utf8"),
);

let seq = 0;

/**
 * 除指定字段外，所有可探询字段取值完全一致的房源。
 * 用来把"某个字段有没有分歧"这件事从真实数据的噪声里隔离出来。
 */
function uniformListing(patch: Partial<CleanListing> = {}): CleanListing {
  seq += 1;
  return {
    id: `UNIF${String(seq).padStart(4, "0")}`,
    title: "Uniform",
    propertyType: "HDB",
    listingType: "room",
    roomType: "common_room",
    hdbFlatType: null,
    bedrooms: 1,
    bathrooms: 1,
    sizeSqft: 120,
    district: "D10",
    districtInferred: false,
    area: "Sameville",
    address: "1 Same Road",
    nearestMrt: { station: "Same", line: "EWL", walkMinutes: 5 },
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

/** 连续应用多个 patch，返回最终状态 */
function run(patches: StatePatch[], initial = emptyState()): RequirementState {
  return patches.reduce((state, patch) => applyPatch(state, patch).state, initial);
}

// ===========================================================================
// 归并语义
// ===========================================================================

describe("patch 归并：只动提到的槽位", () => {
  // 这是"中途改主意"能正确工作的全部前提：没被提到的槽位必须原样保留
  it("新 patch 不影响未提及的槽位", () => {
    const state = run([
      { budgetMax: { value: 2800 }, requireCooking: { value: true } },
      { areas: { value: ["West Coast"] } },
    ]);
    assert.equal(state.values.budgetMax, 2800);
    assert.equal(state.values.requireCooking, true);
    assert.deepEqual(state.values.areas, ["West Coast"]);
  });

  it("覆盖同一个槽位时保留新值，并说明改了什么", () => {
    const first = applyPatch(emptyState(), { areas: { value: ["Alpha"] } }).state;
    const { state, changes } = applyPatch(first, { areas: { value: ["Beta"] } });

    assert.deepEqual(state.values.areas, ["Beta"]);
    const change = changes.find((c) => c.slot === "areas");
    assert.equal(change?.kind, "updated");
    assert.deepEqual(change?.from, ["Alpha"]);
    assert.ok(change?.description.includes("Alpha"));
    assert.ok(change?.description.includes("Beta"));
  });

  // undefined（不出现在 patch 里）= 这轮没提到；null = 用户明确要求取消
  it("null 表示明确清除，与「没提到」区分开", () => {
    const first = run([{ budgetMax: { value: 2000 }, requirePet: { value: true } }]);

    const untouched = applyPatch(first, { budgetMax: { value: 2500 } }).state;
    assert.equal(untouched.values.requirePet, true, "没提到的槽位不该消失");

    const { state, changes } = applyPatch(first, { requirePet: { value: null } });
    assert.equal(state.values.requirePet, undefined);
    assert.equal(changes.find((c) => c.slot === "requirePet")?.kind, "cleared");
  });

  it("归并是纯函数，不修改传入的状态", () => {
    const before = run([{ budgetMax: { value: 2000 } }]);
    const snapshot = JSON.stringify(before);
    applyPatch(before, { budgetMax: { value: 9999 }, areas: { value: ["X"] } });
    assert.equal(JSON.stringify(before), snapshot);
  });

  it("每次归并轮次加一，并记录槽位是哪轮写入的", () => {
    const state = run([
      { budgetMax: { value: 2000 } },
      { areas: { value: ["Alpha"] } },
      { requireCooking: { value: true } },
    ]);
    assert.equal(state.turn, 3);
    assert.deepEqual(slotsChangedOnTurn(state, 1), ["budgetMax"]);
    assert.deepEqual(slotsChangedOnTurn(state, 3), ["requireCooking"]);
  });
});

describe("patch 归并：推断不得覆盖原话", () => {
  // 模型很容易从上下文"顺手"推出一个值。如果它能盖掉用户的原话，
  // 用户会发现自己说过的条件莫名其妙变了 —— 这是多轮对话里最伤信任的一类 bug。
  it("低置信度的推断值会被拒绝，原话保留", () => {
    const stated = run([{ listingType: { value: "room", source: "stated" } }]);
    const { state, changes } = applyPatch(stated, {
      listingType: { value: "whole_unit", source: "inferred" },
    });

    assert.equal(state.values.listingType, "room", "用户明说的值被推断覆盖了");
    const change = changes.find((c) => c.slot === "listingType");
    assert.equal(change?.kind, "rejected");
    assert.ok(change?.description.includes("kept what you told me"));
  });

  it("用户再次明说时可以改掉自己之前说的", () => {
    const stated = run([{ listingType: { value: "room", source: "stated" } }]);
    const after = applyPatch(stated, {
      listingType: { value: "whole_unit", source: "stated" },
    }).state;
    assert.equal(after.values.listingType, "whole_unit");
  });

  it("推断值可以填补空槽位，只是不能覆盖已有的原话", () => {
    const state = run([{ bedroomsMin: { value: 2, source: "inferred" } }]);
    assert.equal(state.values.bedroomsMin, 2);
    assert.deepEqual(unconfirmedSlots(state), ["bedroomsMin"]);
  });

  it("推断填的槽位会被列为待确认，明说的不会", () => {
    const state = run([
      { budgetMax: { value: 2000, source: "stated" } },
      { propertyTypes: { value: ["Condominium"], source: "inferred" } },
    ]);
    assert.deepEqual(unconfirmedSlots(state), ["propertyTypes"]);
  });
});

describe("硬性要求", () => {
  it("pinned 槽位会被记录并可复述", () => {
    const { state, changes } = applyPatch(emptyState(), {
      requirePet: { value: true, pinned: true },
    });
    assert.deepEqual(pinnedSlots(state), ["requirePet"]);
    assert.ok(changes.some((c) => c.kind === "pinned"));
  });

  it("后续更新不会意外丢掉 pinned 标记", () => {
    const state = run([
      { budgetMax: { value: 1000, pinned: true } },
      { budgetMax: { value: 1200 } },
    ]);
    assert.deepEqual(pinnedSlots(state), ["budgetMax"]);
  });

  // 状态层和检索层的接口：用户说过"必须"的条件，放宽推演永远不该碰
  it("pinnedSlots 可直接喂给放宽推演的 keep", () => {
    const state = run([
      { budgetMax: { value: 700, pinned: true } },
      { sizeSqftMin: { value: 2000 } },
    ]);
    const relaxations = computeRelaxations(listings, toSearchQuery(state), {
      keep: pinnedSlots(state),
    });
    assert.ok(!relaxations.some((r) => r.key === "budgetMax"), "被 pin 的预算不该被建议放宽");
    assert.ok(relaxations.some((r) => r.key === "sizeSqftMin"));
  });
});

describe("与检索层对接", () => {
  it("toSearchQuery 剥掉元信息后可直接检索", () => {
    const state = run([
      { listingType: { value: "room" } },
      { budgetMax: { value: 1500 }, requireCooking: { value: true } },
    ]);
    const result = searchListings(listings, toSearchQuery(state), { limit: 1000 });
    for (const hit of result.hits) {
      assert.equal(hit.listing.listingType, "room");
      assert.ok(hit.listing.monthlyRentSgd! <= 1500);
      assert.ok(hit.listing.cookingAllowed);
    }
  });

  it("改主意后重新检索，结果反映的是新条件而不是新旧混合", () => {
    const first = run([{ listingType: { value: "room" }, areas: { value: ["Tampines"] } }]);
    const second = applyPatch(first, { areas: { value: ["Clementi"] } }).state;

    const result = searchListings(listings, toSearchQuery(second), { limit: 1000 });
    assert.ok(result.total > 0);
    for (const hit of result.hits) {
      assert.equal(hit.listing.area, "Clementi", "旧区域没被清掉");
    }
  });

  it("toSearchQuery 返回副本，改它不会污染状态", () => {
    const state = run([{ budgetMax: { value: 2000 } }]);
    const query = toSearchQuery(state);
    query.budgetMax = 9999;
    assert.equal(state.values.budgetMax, 2000);
  });
});

// ===========================================================================
// 缺口驱动的提问
// ===========================================================================

describe("兜底追问（不是主流程）", () => {
  // 主流程是：用户说话 → 抽取 → 检索 → 回答。
  // 只有抽不出任何能筛选的东西时才主动开口，而且只问一句。
  it("状态为空时返回一句最有价值的问题", () => {
    const question = clarifyingQuestion(listings, emptyState());
    assert.ok(question, "什么都没有时必须能问出一句");
    assert.ok(question.question.length > 0);
    assert.ok(question.value > 0);
  });

  it("返回单个问题而不是列表 —— 连问两个就像在填表了", () => {
    const question = clarifyingQuestion(listings, emptyState());
    assert.ok(!Array.isArray(question));
  });

  // 关键：约束够了就闭嘴给结果，让用户对着真实房源反应
  it("约束数够了就不再追问", () => {
    const thin = run([{ budgetMax: { value: 2000 } }]);
    assert.equal(needsClarification(thin), true, "只有一条约束，还不够检索");
    assert.ok(clarifyingQuestion(listings, thin));

    const enough = applyPatch(thin, { listingType: { value: "room" } }).state;
    assert.equal(needsClarification(enough), false);
    assert.equal(
      clarifyingQuestion(listings, enough),
      null,
      "已经能检索了还追问，等于把表单拆成几句话问",
    );
  });

  it("保护性/展示性字段不算作找房约束", () => {
    const state = run([{ tenantGender: { value: "male" } }, { tenantNationality: { value: "X" } }]);
    assert.equal(constraintCount(state), 0);
    assert.equal(needsClarification(state), true);
  });

  it("已经填过的槽位不会被再问一遍", () => {
    const state = run([{ budgetMax: { value: 2000 } }]);
    assert.notEqual(clarifyingQuestion(listings, state)?.slot, "budgetMax");
  });

  // 问一个候选集上取值几乎一致的字段，等于浪费用户一轮。
  // 用合成数据把「只有做饭这一项有分歧」的情形隔离出来，才测得到这个机制。
  it("字段有分歧时会问，取值一致时就不问了", () => {
    // 所有房源除 cookingAllowed 外完全相同
    const split = [
      ...Array.from({ length: 5 }, () => uniformListing({ cookingAllowed: true })),
      ...Array.from({ length: 5 }, () => uniformListing({ cookingAllowed: false })),
    ];
    assert.equal(
      clarifyingQuestion(split, emptyState())?.slot,
      "requireCooking",
      "唯一有分歧的字段就该是问的那个",
    );

    // 同一批房源，把做饭也统一掉 —— 于是没有任何字段值得问
    const uniform = Array.from({ length: 10 }, () => uniformListing({ cookingAllowed: true }));
    assert.equal(
      clarifyingQuestion(uniform, emptyState()),
      null,
      "所有字段取值都一致时，问什么都是浪费用户一轮",
    );
  });

  it("候选已经足够少时停止追问，直接给结果更有价值", () => {
    const tiny = listings.filter((l) => l.dataQuality.isRecommendable).slice(0, 2);
    assert.equal(clarifyingQuestion(tiny, emptyState()), null);
  });

  it("同样的状态永远问同样的问题", () => {
    assert.deepEqual(
      clarifyingQuestion(listings, emptyState()),
      clarifyingQuestion(listings, emptyState()),
    );
  });
});

// ===========================================================================
// 状态可复述
// ===========================================================================

describe("变更可复述", () => {
  // 用户要能看见 agent 理解对了，而不是猜
  it("一次多槽位更新逐条产出说明", () => {
    const first = run([{ budgetMax: { value: 2800 }, areas: { value: ["Tampines"] } }]);
    const { changes } = applyPatch(first, {
      areas: { value: ["Clementi"] },
      requirePet: { value: true },
    });

    assert.equal(changes.length, 2);
    assert.ok(changes.some((c) => c.slot === "areas" && c.kind === "updated"));
    assert.ok(changes.some((c) => c.slot === "requirePet" && c.kind === "set"));
    for (const change of changes) {
      assert.ok(change.description.length > 0);
    }
  });

  it("值没变化时不产生噪音", () => {
    const first = run([{ budgetMax: { value: 2000 } }]);
    const { changes } = applyPatch(first, { budgetMax: { value: 2000 } });
    assert.equal(changes.length, 0, "重复设置同一个值不该报告为变更");
  });

  it("说明里用的是人话字段名，不是代码里的 key", () => {
    const { changes } = applyPatch(emptyState(), { maxLeaseMinMonths: { value: 6 } });
    assert.ok(!changes[0].description.includes("maxLeaseMinMonths"));
    assert.ok(changes[0].description.includes("Longest lease"));
  });
});
