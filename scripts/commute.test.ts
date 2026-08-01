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

import {
  applyCommuteFilter,
  computeRelaxationsWithCommute,
  DEFAULT_MAX_COMMUTE_MINUTES,
  toSummary,
} from "../src/lib/commute.ts";
import { computeRelaxations } from "../src/lib/search.ts";
import type { ScoredListing, SearchResult } from "../src/lib/search.ts";
import type { CleanListing } from "../src/lib/types.ts";
import { departureTime } from "../src/lib/transit.ts";
import type { TransitLookup, TransitProvider } from "../src/lib/transit.ts";

function listing(id: string, station: string | null, walkMinutes = 5): ScoredListing {
  return {
    listing: {
      id,
      nearestMrt: station === null ? null : { station, line: "EWL", walkMinutes },
    },
    score: 0.5,
    // 必须带上 commute 维度：拿到真实通勤时间后要替换它并重算总分
    breakdown: [
      {
        dimension: "commute",
        raw: 0.5,
        weight: 2,
        weighted: 1,
        evidence: `${walkMinutes} min walk to ${station}`,
      },
    ],
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

  it("只给目的地、没给容忍度时按默认 40 分钟筛", async () => {
    const base = result([listing("A", "Bedok", 5), listing("B", "Pasir Ris", 5)]);
    const out = await applyCommuteFilter(
      base,
      { destination: "Raffles Place" },
      stub({ Bedok: 30, "Pasir Ris": 50 }),
    );

    assert.equal(out.hits.length, 1, "55 分钟超过默认上限，该被排除");
    assert.equal(out.hits[0].listing.id, "A");
    assert.equal(out.commute.applied, true);
    assert.equal(out.commute.maxMinutes, DEFAULT_MAX_COMMUTE_MINUTES);
    assert.equal(out.commute.assumedMax, true, "上限是系统给的，必须能被界面标出来");
    assert.equal(out.commute.minutes.get("B"), 55, "被排除的也要有分钟数，才能解释为什么");
  });

  it("用户给了上限就用用户的，并且不标成默认值", async () => {
    const out = await applyCommuteFilter(
      result([listing("A", "Bedok", 5)]),
      { destination: "Raffles Place", maxMinutes: 60 },
      stub({ Bedok: 50 }),
    );
    assert.equal(out.hits.length, 1, "55 分钟在用户自己给的 60 分钟以内");
    assert.equal(out.commute.maxMinutes, 60);
    assert.equal(out.commute.assumedMax, false);
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

    assert.deepEqual(out.hits.map((h) => h.listing.id).sort(), ["A", "B"]);
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

    assert.deepEqual(out.hits.map((h) => h.listing.id).sort(), ["A", "C"]);
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

// ---------------------------------------------------------------------------

/**
 * 出发时刻的时区。
 *
 * 这个 bug 错得极其隐蔽：API 照常返回合法数字，只是答的不是同一个问题。
 * 实际踩到的两种错法 ——
 *   开发机 PDT：setHours(9) 算出新加坡周日凌晨 0 点，只能等首班车，
 *              Pasir Ris → Raffles Place 查出 5 小时 10 分钟（真实约 45 分钟）
 *   Vercel UTC：算出新加坡下午 5 点晚高峰
 * 两种都不是"工作日早上 9 点通勤"。
 */
describe("出发时刻固定在新加坡工作日早高峰", () => {
  const sgHour = (ts: number) =>
    Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Singapore",
        hour: "2-digit",
        hour12: false,
      }).format(new Date(ts * 1000)),
    );
  const sgWeekday = (ts: number) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Singapore",
      weekday: "short",
    }).format(new Date(ts * 1000));

  it("无论服务器在哪个时区，都是新加坡时间 09:00", () => {
    // 覆盖一整年的各个日期，任何一天算出来都必须是 SGT 09:00
    for (let day = 0; day < 365; day += 7) {
      const now = new Date(Date.UTC(2026, 0, 1 + day, 17, 30));
      const ts = departureTime(now);
      assert.equal(sgHour(ts), 9, `${now.toISOString()} 算出的不是 SGT 09:00`);
    }
  });

  it("永远落在工作日", () => {
    for (let day = 0; day < 30; day += 1) {
      const ts = departureTime(new Date(Date.UTC(2026, 6, 1 + day, 3, 0)));
      const weekday = sgWeekday(ts);
      assert.ok(weekday !== "Sat" && weekday !== "Sun", `落到了 ${weekday}`);
    }
  });

  it("永远是将来的时刻 —— transit 模式不接受过去的出发时间", () => {
    const now = new Date();
    assert.ok(departureTime(now) > Math.floor(now.getTime() / 1000));
  });
});

// ---------------------------------------------------------------------------

/**
 * Map 过不了 JSON。
 *
 * `JSON.stringify(new Map([["a",1]]))` 是 `"{}"` —— 不报错，数据静悄悄没了。
 * 线上踩过：通勤筛选正常、模型也拿到了分钟数，但前端卡片上的时间死活不显示。
 */
describe("通勤结果要能过 JSON", () => {
  it("摊平后 JSON 往返不丢分钟数", async () => {
    const base = result([listing("A", "Bedok", 5), listing("B", "Eunos", 3)]);
    const out = await applyCommuteFilter(
      base,
      { destination: "Raffles Place", maxMinutes: 60 },
      stub({ Bedok: 30, Eunos: 25 }),
    );

    const wire = JSON.parse(JSON.stringify(toSummary(out.commute)));
    assert.deepEqual(wire.minutes, { A: 35, B: 28 });
    assert.equal(wire.applied, true);
    assert.equal(wire.unverified, 0);
  });

  it("直接序列化原始结果会丢数据 —— 这就是必须摊平的原因", () => {
    const raw = { minutes: new Map([["A", 35]]) };
    assert.deepEqual(JSON.parse(JSON.stringify(raw)).minutes, {}, "Map 会变成空对象");
  });
});

// ---------------------------------------------------------------------------

/**
 * 放宽推演必须把通勤算进去。
 *
 * 纯内存版报的是"放宽后数据库里多出几套"，但那些新房源还得再过一遍通勤。
 * 实测偏差 2.5 倍：预算 $900 + 通勤≤40 分钟当前 9 套，纯内存版说松到
 * $990 能多出 5 套，实际只多 2 套。用户拿这个数决定要不要多花 $90。
 */
describe("放宽推演算上通勤", () => {
  const pool = [
    // 站 → 到目的地的列车分钟数：Near 10、Far 50
    mk("A", 800, "Near"),
    mk("B", 850, "Near"),
    mk("C", 950, "Near"), // 预算放宽后进来，通勤也过
    mk("D", 960, "Far"), // 预算放宽后进来，但通勤超标
    mk("E", 970, "Far"), // 同上
  ];

  function mk(id: string, rent: number, station: string) {
    return {
      id,
      listingType: "room",
      monthlyRentSgd: rent,
      nearestMrt: { station, line: "EWL", walkMinutes: 5 },
      bedrooms: 1,
      bathrooms: 1,
      sizeSqft: 200,
      area: "X",
      district: "D01",
      propertyType: "HDB",
      furnishing: "fully",
      leaseMinMonths: 6,
      availableFrom: "2026-08-01",
      postedDate: "2026-07-20",
      isImmediate: true,
      cookingAllowed: true,
      petFriendly: true,
      aircon: true,
      utilitiesIncluded: true,
      amenities: [],
      directOwner: true,
      agentFee: "none",
      rentNegotiable: false,
      districtInferred: false,
      rentPercentileInCohort: 0.5,
      roomType: "common",
      tenantPreferences: { gender: null, nationality: null, occupantType: "any" },
      dataQuality: { flags: [], isRecommendable: true },
      title: id,
    } as unknown as CleanListing;
  }

  const transit = stub({ Near: 10, Far: 50 });
  const query = {
    listingType: "room" as const,
    budgetMax: 900,
    commute: { destination: "Raffles Place", maxMinutes: 40 },
  };

  it("放宽后多出来的房源也要过通勤这一关", async () => {
    const withCommute = await computeRelaxationsWithCommute(pool, query, transit);
    const budget = withCommute.find((r) => r.key === "budgetMax");

    // 当前：A、B（Near，15 分钟）通过；C/D/E 超预算
    assert.equal(budget?.hitsBefore, 2);
    // 放宽到 $990：C 进来（Near，15 分钟 ✓），D/E 进来但 55 分钟 ✗
    assert.equal(budget?.hitsAfter, 3);
    assert.equal(budget?.delta, 1, "只能多 1 套，不是 3 套");
  });

  it("纯内存版会高估 —— 这就是必须分两版的原因", () => {
    const naive = computeRelaxations(pool, query);
    const budget = naive.find((r) => r.key === "budgetMax");
    assert.equal(budget?.delta, 3, "纯内存版数的是数据库里多出几套，没过通勤");
  });

  it("没有通勤约束时两版结果完全一致", async () => {
    const plain = { listingType: "room" as const, budgetMax: 900 };
    const a = computeRelaxations(pool, plain);
    const b = await computeRelaxationsWithCommute(pool, plain, NEVER_CALLED);
    assert.deepEqual(b, a);
  });
});

// ---------------------------------------------------------------------------

/**
 * 出行方式必须一路传到底。
 *
 * 实测的差距足以决定成败：Bedok → Bukit Timah 地铁 65 分钟、开车 22 分钟。
 * 用户说"开车 20 分钟内"，拿地铁时间去筛就是把几乎所有房源误杀。
 */
describe("出行方式", () => {
  function recordingProvider() {
    const calls: Array<string | undefined> = [];
    const provider: TransitProvider = {
      async lookup(_stations, _destination, mode) {
        calls.push(mode);
        return { minutes: new Map([["Near", 10]]), resolved: true };
      },
    };
    return { provider, calls };
  }

  it("mode 传给 provider，不是写死 transit", async () => {
    const { provider, calls } = recordingProvider();
    await applyCommuteFilter(
      result([listing("A", "Near", 5)]),
      { destination: "Bukit Timah", mode: "drive", maxMinutes: 20 },
      provider,
    );
    assert.deepEqual(calls, ["drive"]);
  });

  it("公共交通要加上步行到站的时间", async () => {
    const out = await applyCommuteFilter(
      result([listing("A", "Near", 5)]),
      { destination: "X", mode: "mrt", maxMinutes: 60 },
      stub({ Near: 10 }),
    );
    assert.equal(out.commute.minutes.get("A"), 15, "5 分钟步行 + 10 分钟车程");
  });

  it("没说方式时按公共交通算", async () => {
    const out = await applyCommuteFilter(
      result([listing("A", "Near", 5)]),
      { destination: "X", maxMinutes: 60 },
      stub({ Near: 10 }),
    );
    assert.equal(out.commute.minutes.get("A"), 15);
  });

  it("开车不加步行到站 —— 没人先走到地铁站再开车", async () => {
    const out = await applyCommuteFilter(
      result([listing("A", "Near", 5)]),
      { destination: "X", mode: "drive", maxMinutes: 60 },
      stub({ Near: 10 }),
    );
    assert.equal(out.commute.minutes.get("A"), 10, "只算车程，不叠加步行段");
  });
});

// ---------------------------------------------------------------------------

/**
 * 「离 X 近」是软偏好，该体现在排序上，不该变成硬过滤。
 *
 * 真实事故：用户说"孩子在 Bukit Timah 上学，住附近就好"，系统把它写进了
 * areas（硬过滤 = 房子必须位于该区），把一套 34 分钟车程、其余条件全中的
 * 房源直接扔掉了。用户看到"没有符合的"，却不知道是被一条自己没提过的
 * 住址限制挡住的。
 */
describe("只给目的地时按通勤排序，不排除任何人", () => {
  it("近的排前面，够近的都还在结果里", async () => {
    const base = result([
      listing("FAR", "Far", 2), // 2 + 30 = 32 分钟，但走到地铁站只要 2 分钟
      listing("NEAR", "Near", 8), // 8 + 10 = 18 分钟
    ]);
    const out = await applyCommuteFilter(
      base,
      { destination: "Bukit Timah" }, // 没有 maxMinutes，走默认 40 分钟
      stub({ Far: 30, Near: 10 }),
    );

    assert.equal(out.hits.length, 2, "两套都在 40 分钟以内");
    assert.equal(out.hits[0].listing.id, "NEAR", "18 分钟的该排在 32 分钟前面");
  });

  it("排序用的是门到门时间，不是走到地铁站的时间", async () => {
    // FAR 走到地铁站更快（2 vs 8），但总时长差得多 —— 旧逻辑会把它排在前面
    const base = result([listing("FAR", "Far", 2), listing("NEAR", "Near", 8)]);
    const out = await applyCommuteFilter(
      base,
      { destination: "X" },
      stub({ Far: 30, Near: 10 }),
    );
    const near = out.hits.find((h) => h.listing.id === "NEAR");
    const far = out.hits.find((h) => h.listing.id === "FAR");
    assert.ok((near?.score ?? 0) > (far?.score ?? 0));
  });

  it("重打分后的证据写的是门到门，便于解释推荐理由", async () => {
    const out = await applyCommuteFilter(
      result([listing("A", "Near", 5)]),
      { destination: "Bukit Timah" },
      stub({ Near: 10 }),
    );
    const commute = out.hits[0].breakdown.find((c) => c.dimension === "commute");
    assert.match(commute?.evidence ?? "", /15 min door-to-door to Bukit Timah/);
  });
});
