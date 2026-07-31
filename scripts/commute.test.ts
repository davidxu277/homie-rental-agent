/**
 * 通勤过滤层的测试。
 *
 *   node --test scripts/commute.test.ts
 *
 * 全程用桩，不发网络请求。这一层的价值恰恰在**外部依赖不可靠时的行为** ——
 * 服务超时、目的地解析不出来、某个站查不到路线，这三种情况下都不能让用户
 * 看到一个"筛过了"的假象，也不能让整轮对话失败。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyCommuteFilter } from "../src/lib/commute.ts";
import type { ScoredListing, SearchResult } from "../src/lib/search.ts";
import type { TransitLookup, TransitProvider } from "../src/lib/transit.ts";

function listing(id: string, station: string | null, walkMinutes = 5): ScoredListing {
  return {
    listing: {
      id,
      nearestMrt: station === null ? null : { station, line: "EWL", walkMinutes },
    },
    score: 0.5,
    breakdown: [],
    matched: [],
    caveats: [],
  } as unknown as ScoredListing;
}

function result(hits: ScoredListing[]): SearchResult {
  return { hits, total: hits.length, excludedBy: {}, pool: hits.length };
}

/** 返回固定分钟数的桩 */
function stub(minutes: Record<string, number>, resolved = true): TransitProvider {
  return {
    async lookup(): Promise<TransitLookup> {
      return {
        minutes: new Map(Object.entries(minutes)),
        resolved,
        ...(resolved ? {} : { error: "stubbed failure" }),
      };
    },
  };
}

const NEVER_CALLED: TransitProvider = {
  async lookup(): Promise<TransitLookup> {
    throw new Error("不该被调用");
  },
};

describe("通勤过滤", () => {
  it("门到门 = 步行到站 + 列车段，超过容忍度的被排除", async () => {
    const base = result([
      listing("A", "Bedok", 5), //  5 + 30 = 35 ✓
      listing("B", "Pasir Ris", 5), // 5 + 50 = 55 ✗
      listing("C", "Eunos", 12), // 12 + 25 = 37 ✓
    ]);
    const out = await applyCommuteFilter(
      base,
      { destination: "Raffles Place", maxMinutes: 40 },
      stub({ Bedok: 30, "Pasir Ris": 50, Eunos: 25 }),
    );

    assert.deepEqual(out.hits.map((h) => h.listing.id), ["A", "C"]);
    assert.equal(out.total, 2);
    assert.equal(out.commute.applied, true);
    assert.equal(out.commute.minutes.get("A"), 35);
    assert.equal(out.commute.minutes.get("C"), 37);
  });

  it("只给目的地、没给容忍度时不筛，但仍然算出分钟数展示", async () => {
    const base = result([listing("A", "Bedok", 5), listing("B", "Pasir Ris", 5)]);
    const out = await applyCommuteFilter(
      base,
      { destination: "Raffles Place" },
      stub({ Bedok: 30, "Pasir Ris": 50 }),
    );

    assert.equal(out.hits.length, 2, "没有阈值就不该排除任何房源");
    assert.equal(out.commute.applied, false, "没筛就不能说筛了");
    assert.equal(out.commute.minutes.get("B"), 55, "但分钟数照样要给用户看");
  });

  it("没有 commute 时完全不碰结果，也不调外部服务", async () => {
    const base = result([listing("A", "Bedok")]);
    const out = await applyCommuteFilter(base, undefined, NEVER_CALLED);
    assert.equal(out.hits.length, 1);
    assert.equal(out.commute.applied, false);
  });

  it("外部服务不可用时降级为不筛 —— 而不是筛出 0 套", async () => {
    const base = result([listing("A", "Bedok"), listing("B", "Pasir Ris")]);
    const out = await applyCommuteFilter(
      base,
      { destination: "Nowhere", maxMinutes: 40 },
      stub({}, false),
    );

    assert.equal(out.hits.length, 2, "查不到就该原样放行，让用户看到房源");
    assert.equal(out.total, 2);
    assert.equal(out.commute.applied, false);
    assert.ok(out.commute.reason, "必须带上原因，agent 要如实转达");
  });

  it("缺最近地铁站的房源照常放行，并计入 unverified", async () => {
    const base = result([listing("A", "Bedok", 5), listing("B", null)]);
    const out = await applyCommuteFilter(
      base,
      { destination: "Raffles Place", maxMinutes: 40 },
      stub({ Bedok: 30 }),
    );

    assert.deepEqual(out.hits.map((h) => h.listing.id), ["A", "B"]);
    assert.equal(out.commute.unverified, 1);
    assert.equal(out.commute.minutes.has("B"), false, "没核算过就不该有分钟数");
  });

  it("个别站查不到路线时，只有那几套算 unverified，其余照常筛", async () => {
    const base = result([
      listing("A", "Bedok", 5), // 35 ✓
      listing("B", "Pasir Ris", 5), // 55 ✗
      listing("C", "Mystery", 5), // 查不到 → 放行
    ]);
    const out = await applyCommuteFilter(
      base,
      { destination: "Raffles Place", maxMinutes: 40 },
      stub({ Bedok: 30, "Pasir Ris": 50 }),
    );

    assert.deepEqual(out.hits.map((h) => h.listing.id), ["A", "C"]);
    assert.equal(out.commute.unverified, 1);
    assert.equal(out.commute.applied, true);
  });

  it("边界值算通过 —— 正好 40 分钟不该被排除", async () => {
    const base = result([listing("A", "Bedok", 10)]);
    const out = await applyCommuteFilter(
      base,
      { destination: "Raffles Place", maxMinutes: 40 },
      stub({ Bedok: 30 }),
    );
    assert.equal(out.hits.length, 1);
    assert.equal(out.commute.minutes.get("A"), 40);
  });

  it("候选集为空时不调外部服务", async () => {
    const out = await applyCommuteFilter(
      result([]),
      { destination: "Raffles Place", maxMinutes: 40 },
      NEVER_CALLED,
    );
    assert.equal(out.hits.length, 0);
  });
});
