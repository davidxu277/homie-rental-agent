/**
 * 抽取契约层的测试。
 *
 *   node --test scripts/extract.test.ts
 *
 * 全部是纯函数测试，不发网络请求 —— 测的是**模型返回值进入系统前的最后一道关**。
 * 模型会犯的错（编地名、给负数、用错槽位名、同时 set 又 clear）在这里必须被拦下。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPatchSchema,
  EXTRACTABLE_SLOTS,
  validatePatch,
  type ExtractedPatch,
} from "../src/lib/extract.ts";
import type { Vocab } from "../src/lib/vocab.ts";

/** 手写的小词表 —— 把测试和真实数据解耦 */
const VOCAB: Vocab = {
  areas: ["Clementi", "Tampines", "one-north"],
  stations: ["Buona Vista", "Dover"],
  districts: ["D05", "D18"],
  amenities: ["Gym", "Swimming Pool"],
  occupantTypes: ["any", "student", "family"],
};

/**
 * @param userText 用户原话。通勤的方式和时长要靠它举证 ——
 *   缺省是空串（= 无从核对），这两项会被守卫剥掉。
 */
function run(patch: ExtractedPatch, userText = "") {
  return validatePatch(patch, VOCAB, {}, userText);
}

// ===========================================================================

describe("校验：闭集是硬边界", () => {
  // 模型明明拿到了闭集清单，仍可能返回列表外的值 —— 这一层才是强制力，
  // schema 和 system prompt 只是让它更容易做对
  it("闭集外的地点被丢弃", () => {
    const { patch, dropped } = run({ set: { areas: ["Kent Ridge"] } });
    assert.equal(patch.areas, undefined);
    assert.equal(dropped[0].reason, "not in the closed vocabulary");
  });

  // 部分越界时只丢那几项，不要整条扔掉 —— 用户说的另外几个地方是有效的
  it("数组里部分越界时，保留合法项", () => {
    const { patch, dropped } = run({
      set: { areas: ["Clementi", "Atlantis", "Tampines"] },
    });
    assert.deepEqual(patch.areas?.value, ["Clementi", "Tampines"]);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].value, "Atlantis");
  });

  it("大小写不一致时归一化成词表里的写法", () => {
    const { patch } = run({ set: { areas: ["CLEMENTI", "one-North"] } });
    assert.deepEqual(patch.areas?.value, ["Clementi", "one-north"]);
  });

  it("全部越界时该槽位整个不出现，而不是变成空数组", () => {
    const { patch } = run({ set: { areas: ["Atlantis", "Narnia"] } });
    assert.equal(patch.areas, undefined);
  });

  it("未登记的槽位名被丢弃", () => {
    const { patch, dropped } = run({
      set: { madeUpSlot: 123 } as unknown as ExtractedPatch["set"],
    });
    assert.deepEqual(patch, {});
    assert.equal(dropped[0].reason, "unknown slot");
  });
});

describe("校验：类型", () => {
  it("数值槽位拒绝非正数和字符串", () => {
    for (const bad of [-100, 0, "2500", null]) {
      const { patch } = run({
        set: { budgetMax: bad } as unknown as ExtractedPatch["set"],
      });
      assert.equal(patch.budgetMax, undefined, `不该接受 ${JSON.stringify(bad)}`);
    }
    assert.equal(run({ set: { budgetMax: 2500 } }).patch.budgetMax?.value, 2500);
  });

  it("布尔槽位拒绝字符串 true", () => {
    const { patch } = run({
      set: { requireCooking: "true" } as unknown as ExtractedPatch["set"],
    });
    assert.equal(patch.requireCooking, undefined);
  });

  it("日期必须是 YYYY-MM-DD", () => {
    assert.equal(run({ set: { moveInBy: "2026-09-01" } }).patch.moveInBy?.value, "2026-09-01");
    for (const bad of ["九月", "2026/09/01", "Sep 2026", "immediate"]) {
      assert.equal(run({ set: { moveInBy: bad } }).patch.moveInBy, undefined, `不该接受 ${bad}`);
    }
  });
});

describe("校验：来源与硬性要求", () => {
  it("inferred 名单里的槽位标成推断来源", () => {
    const { patch } = run({ set: { budgetMax: 2000 }, inferred: ["budgetMax"] });
    assert.equal(patch.budgetMax?.source, "inferred");
  });

  it("默认是用户明说", () => {
    assert.equal(run({ set: { budgetMax: 2000 } }).patch.budgetMax?.source, "stated");
  });

  it("pin 名单里的槽位带上硬性标记", () => {
    const { patch } = run({ set: { requirePet: true }, pin: ["requirePet"] });
    assert.equal(patch.requirePet?.pinned, true);
  });
});

describe("校验：清除与替换", () => {
  it("clear 转成显式的 null", () => {
    const { patch } = run({ clear: ["requireCooking"] });
    assert.equal(patch.requireCooking?.value, null);
  });

  it("clear 里的未知槽位被丢弃", () => {
    const { patch, dropped } = run({ clear: ["nonsense"] });
    assert.deepEqual(patch, {});
    assert.equal(dropped[0].reason, "unknown slot (clear)");
  });

  // 模型表达"把 A 换成 B"时经常同时给出 set 和 clear。
  // 如果 clear 赢，用户看到的是"区域没了"而不是"区域变了" —— 实测踩过这个坑。
  it("同一槽位既 set 又 clear 时，set 赢（视为替换）", () => {
    const { patch, dropped } = run({
      set: { areas: ["Clementi"] },
      clear: ["areas"],
    });
    assert.deepEqual(patch.areas?.value, ["Clementi"]);
    assert.ok(dropped.some((d) => d.reason.includes("treated as replacement")));
  });
});

describe("相对调整：模型只给方向，数值由固定档位算", () => {
  // 这么设计的起因：模型自己算的数字会被标成"推断值"，撞上状态层
  // "推断不得覆盖原话"的规则被丢弃 —— 用户说了"再便宜点"却什么都没发生。
  it("再便宜点 = 预算按档位降 10%", () => {
    const { patch } = validatePatch(
      { adjust: [{ slot: "budgetMax", direction: "down" }] },
      VOCAB,
      { budgetMax: 2500 },
    );
    assert.equal(patch.budgetMax?.value, 2250);
  });

  it("来源是 stated 而非 inferred —— 否则会被状态层拦掉", () => {
    const { patch } = validatePatch(
      { adjust: [{ slot: "budgetMax", direction: "down" }] },
      VOCAB,
      { budgetMax: 2500 },
    );
    assert.equal(patch.budgetMax?.source, "stated");
  });

  it("方向是用户视角：大一点 → 面积变大，走远点 → 分钟数变大", () => {
    const bigger = validatePatch(
      { adjust: [{ slot: "sizeSqftMin", direction: "up" }] },
      VOCAB,
      { sizeSqftMin: 800 },
    );
    assert.equal(bigger.patch.sizeSqftMin?.value, 880);

    const farther = validatePatch(
      { adjust: [{ slot: "maxWalkMinutes", direction: "up" }] },
      VOCAB,
      { maxWalkMinutes: 10 },
    );
    assert.equal(farther.patch.maxWalkMinutes?.value, 15);
  });

  it("租期按倍数走，不是按比例", () => {
    const { patch } = validatePatch(
      { adjust: [{ slot: "maxLeaseMinMonths", direction: "up" }] },
      VOCAB,
      { maxLeaseMinMonths: 6 },
    );
    assert.equal(patch.maxLeaseMinMonths?.value, 12);
  });

  it("当前没有该约束时不瞎猜基准，丢弃并说明原因", () => {
    const { patch, dropped } = validatePatch(
      { adjust: [{ slot: "budgetMax", direction: "down" }] },
      VOCAB,
      {},
    );
    assert.equal(patch.budgetMax, undefined);
    assert.ok(dropped[0].reason.includes("no existing value to adjust from"));
  });

  it("同轮给了具体数字时，数字优先于相对调整", () => {
    const { patch, dropped } = validatePatch(
      {
        set: { budgetMax: 1000 },
        adjust: [{ slot: "budgetMax", direction: "down" }],
      },
      VOCAB,
      { budgetMax: 2500 },
    );
    assert.equal(patch.budgetMax?.value, 1000);
    assert.ok(dropped.some((d) => d.reason.includes("relative adjustment ignored")));
  });

  it("不支持相对调整的槽位被丢弃", () => {
    const { patch, dropped } = validatePatch(
      { adjust: [{ slot: "requireCooking", direction: "up" }] },
      VOCAB,
      {},
    );
    assert.deepEqual(patch, {});
    assert.ok(dropped[0].reason.includes("does not support relative adjustment"));
  });

  // 反复"再便宜点"不能把预算调成 0 或负数
  it("调整后不是正数就丢弃", () => {
    const { patch, dropped } = validatePatch(
      { adjust: [{ slot: "bedroomsMin", direction: "down" }] },
      VOCAB,
      { bedroomsMin: 1 },
    );
    assert.equal(patch.bedroomsMin, undefined);
    assert.ok(dropped[0].reason.includes("not positive"));
  });

  it("幅度和放宽建议共用同一组档位常量", async () => {
    const { NOTCH_STEP } = await import("../src/lib/search.ts");
    const { patch } = validatePatch(
      { adjust: [{ slot: "budgetMax", direction: "up" }] },
      VOCAB,
      { budgetMax: 1000 },
    );
    assert.equal(patch.budgetMax?.value, Math.round(1000 * (1 + NOTCH_STEP.budgetPct)));
  });
});

describe("拿不准就问，不要猜", () => {
  // 实测踩到的：用户说 "i work in the city"，模型直接锁死 areas:["City Hall"]。
  // city 可能是 Raffles Place / Tanjong Pagar / Marina Bay —— 挑一个填进去，
  // 用户根本不知道系统替他做了这个决定，然后一直被这个条件卡着。
  it("标了 ambiguous 的槽位不写入状态", () => {
    const { patch, ambiguous } = run({
      set: { areas: ["Clementi"] },
      ambiguous: [{ slot: "areas", question: "你说的 city 是指哪一带？" }],
    });
    assert.equal(patch.areas, undefined, "模型的猜测值正是问题所在，不该写进去");
    assert.equal(ambiguous.length, 1);
    assert.equal(ambiguous[0].question, "你说的 city 是指哪一带？");
  });

  it("丢弃时记下原因，便于排查模型是不是滥用了这个出口", () => {
    const { dropped } = run({
      set: { budgetMax: 2000 },
      ambiguous: [{ slot: "budgetMax", question: "你的预算大概多少？" }],
    });
    assert.ok(dropped.some((d) => d.reason.includes("uncertain")));
  });

  it("没标 ambiguous 的槽位照常写入", () => {
    const { patch } = run({
      set: { areas: ["Clementi"], budgetMax: 2000 },
      ambiguous: [{ slot: "areas", question: "哪一带？" }],
    });
    assert.equal(patch.areas, undefined);
    assert.equal(patch.budgetMax?.value, 2000);
  });

  it("非法的 ambiguous 条目被忽略（未知槽位、空问题）", () => {
    const { ambiguous } = run({
      ambiguous: [
        { slot: "nonsense", question: "?" },
        { slot: "areas", question: "   " },
        { slot: "budgetMax", question: "预算多少？" },
      ],
    });
    assert.equal(ambiguous.length, 1);
    assert.equal(ambiguous[0].slot, "budgetMax");
  });
});

describe("校验：脏输入不崩", () => {
  it("非对象输入返回空 patch", () => {
    for (const bad of [null, "text", 42, undefined]) {
      const { patch, dropped } = validatePatch(bad, VOCAB);
      assert.deepEqual(patch, {});
      assert.ok(dropped.length > 0);
    }
  });

  it("空 patch 是合法的（这一轮用户没提任何约束）", () => {
    const { patch, dropped } = run({ set: {}, clear: [], pin: [], inferred: [] });
    assert.deepEqual(patch, {});
    assert.deepEqual(dropped, []);
  });
});

// ===========================================================================
// 敏感字段：防线推到抽取层
// ===========================================================================

describe("国籍偏好在抽取层就不存在", () => {
  it("槽位清单里没有 tenantNationality", () => {
    assert.ok(!EXTRACTABLE_SLOTS.includes("tenantNationality" as never));
  });

  it("schema 里没有对应字段 —— 模型表达不出来", () => {
    const schema = buildPatchSchema(VOCAB) as {
      properties: { set: { properties: Record<string, unknown> } };
    };
    assert.equal(schema.properties.set.properties.tenantNationality, undefined);
    assert.ok(schema.properties.set.properties.tenantGender, "性别走另一条路径，应该保留");
  });

  it("模型硬塞也会被丢弃", () => {
    const { patch, dropped } = run({
      set: { tenantNationality: "Chinese" } as unknown as ExtractedPatch["set"],
    });
    assert.deepEqual(patch, {});
    assert.equal(dropped[0].reason, "unknown slot");
  });
});

// ===========================================================================
// schema 形状：这些是踩过 400 才定下来的，别改回去
// ===========================================================================

describe("schema 的两个硬约束", () => {
  // 结构化输出限制可选参数 ≤ 24；顶层字段全设为必填后，可选数只剩 set 的 22 个
  it("顶层字段全是必填，把可选计数压到 24 以内", () => {
    const schema = buildPatchSchema(VOCAB) as {
      required: string[];
      properties: { set: { properties: Record<string, unknown> } };
    };
    assert.deepEqual(schema.required.slice().sort(), [
      "adjust",
      "ambiguous",
      "clear",
      "inferred",
      "locationNote",
      "pin",
      "set",
      "wantsRelaxAdvice",
      "wantsResultsNow",
    ]);
    assert.ok(
      Object.keys(schema.properties.set.properties).length <= 24,
      "set 的可选字段数超了会 400",
    );
  });

  // 170+ 个枚举值会让 API 报 "Schema is too complex"
  it("大闭集不进 enum，只有小枚举保留", () => {
    const set = (
      buildPatchSchema(VOCAB) as {
        properties: { set: { properties: Record<string, { items?: { enum?: string[] } }> } };
      }
    ).properties.set.properties;

    for (const slot of ["areas", "stations", "districts", "amenities"]) {
      assert.equal(set[slot].items?.enum, undefined, `${slot} 不该有 enum`);
    }
    assert.deepEqual(set.furnishing.items?.enum, ["fully", "partial", "unfurnished"]);
  });
});

// ---------------------------------------------------------------------------

/**
 * 通勤 ≠ 住址。
 *
 * 起因是一次真实失败："I work near Raffles Place so somewhere I can get to the CBD
 * in under 40 min by MRT" 被抽成了 maxWalkMinutes=40 + stations=[Raffles Place]。
 * 前者在 494 套上全部通过（等于空转），后者把结果直接清零 ——
 * 一个几乎不排除任何东西的要求，变成了整个查询里最紧的一条。
 *
 * 根因不是模型笨，是槽位表里没有"目的地"这个概念，它无处可放。
 */
describe("通勤目的地是独立槽位", () => {
  it("目的地落进 commute，不污染住址槽位", () => {
    const { patch, dropped } = run(
      { set: { commute: { destination: "Buona Vista", mode: "mrt", maxMinutes: 40 } } },
      "I take the MRT to Buona Vista, under 40 minutes please",
    );
    assert.deepEqual(patch.commute?.value, {
      destination: "Buona Vista",
      mode: "mrt",
      maxMinutes: 40,
    });
    assert.equal(patch.stations, undefined, "目的地不该写进 stations");
    assert.equal(patch.maxWalkMinutes, undefined, "通勤时间不该写进步行时间");
    assert.equal(dropped.length, 0);
  });

  it("目的地不走闭集 —— 词表外的真实地点照样收下", () => {
    const value = run(
      { set: { commute: { destination: "NUS", maxMinutes: 30 } } },
      "i'm a nus student, find me a room where i can go to school within 30 mins",
    ).patch.commute?.value as { destination: string; maxMinutes?: number };
    assert.equal(value.destination, "NUS", "NUS 不在房源词表里，但它是个真实目的地");
    assert.equal(value.maxMinutes, 30);
  });

  it("口语补全成正式名也认 —— 实词对得上就算有依据", () => {
    const value = run(
      { set: { commute: { destination: "Changi Airport" } } },
      "I work at the airport",
    ).patch.commute?.value as { destination: string };
    assert.equal(value.destination, "Changi Airport");
  });

  it("用户没提过的目的地整条丢弃", () => {
    const { patch, dropped } = run(
      { set: { commute: { destination: "Atlantis", maxMinutes: 30 } } },
      "I need a place under $2,000",
    );
    assert.equal(patch.commute, undefined);
    assert.ok(dropped.some((d) => d.slot === "commute.destination"));
  });

  it("方位词不足以给编造的目的地背书", () => {
    const { patch } = run(
      { set: { commute: { destination: "Jurong East" } } },
      "somewhere on the east side would be nice",
    );
    assert.equal(patch.commute, undefined, '"east" 是通用方位词，不算依据');
  });

  it("站名和区域名都能当目的地", () => {
    assert.equal(
      (run({ set: { commute: { destination: "Clementi" } } }, "I work in Clementi").patch.commute
        ?.value as { destination: string }).destination,
      "Clementi",
    );
    assert.equal(
      (run({ set: { commute: { destination: "dover" } } }, "my office is at dover").patch.commute
        ?.value as { destination: string }).destination,
      "Dover",
      "应当大小写归一",
    );
  });

  it("方式认不出时只丢方式，目的地保留 —— 部分信息比零信息有用", () => {
    const value = run(
      { set: { commute: { destination: "Clementi", mode: "teleport", maxMinutes: 20 } } },
      "I teleport to Clementi in 20 minutes",
    ).patch.commute?.value as { destination: string; mode?: string; maxMinutes?: number };
    assert.equal(value.destination, "Clementi");
    assert.equal(value.mode, undefined);
    assert.equal(value.maxMinutes, 20);
  });

  it("非法的分钟数被忽略，不影响其余字段", () => {
    const value = run(
      { set: { commute: { destination: "Clementi", maxMinutes: -5 } } },
      "I work in Clementi",
    ).patch.commute?.value as { destination: string; maxMinutes?: number };
    assert.equal(value.destination, "Clementi");
    assert.equal(value.maxMinutes, undefined);
  });

  it("不是对象就丢弃", () => {
    const { patch, dropped } = run({
      set: { commute: "Raffles Place" as unknown as { destination: string } },
    });
    assert.equal(patch.commute, undefined);
    assert.ok(dropped.length > 0);
  });

  it("commute 在合法槽位清单里", () => {
    assert.ok(EXTRACTABLE_SLOTS.includes("commute"));
  });
});

// ---------------------------------------------------------------------------

/**
 * 通勤的方式和时长必须有用户原话支撑。
 *
 * 真实事故：用户说 "the children will study around Bukit Timah, so somewhere
 * close would be great" —— 一个字没提交通工具和时长，系统却抽出
 * `by DRIVE, under 20 min`，两者都成了硬过滤。用户看不出这个 20 分钟哪来的，
 * 也不知道自己被挡掉了多少房源。
 *
 * 而且这个编造是**间歇性的**，同一句话复现两次都正常 —— 所以不能靠 prompt，
 * 必须有代码层面的客观检验。和地点走闭集是同一个思路。
 */
describe("通勤的方式和时长要有原话支撑", () => {
  const SAID_NOTHING =
    "Location matters a lot — the children will study around Bukit Timah, so somewhere close would be great.";

  it("没提交通工具和时长时，两个都被丢弃，目的地保留", () => {
    const { patch, dropped } = validatePatch(
      { set: { commute: { destination: "Bukit Timah", mode: "drive", maxMinutes: 20 } } },
      VOCAB,
      {},
      SAID_NOTHING,
    );
    assert.deepEqual(patch.commute?.value, { destination: "Bukit Timah" });
    assert.equal(dropped.filter((d) => d.slot.startsWith("commute.")).length, 2);
  });

  it("用户确实说了就保留", () => {
    const { patch } = validatePatch(
      { set: { commute: { destination: "Clementi", mode: "drive", maxMinutes: 20 } } },
      VOCAB,
      {},
      "I drive to work in Clementi and need to be within 20 minutes",
    );
    assert.deepEqual(patch.commute?.value, {
      destination: "Clementi",
      mode: "drive",
      maxMinutes: 20,
    });
  });

  it("「close / nearby / not too far」都不是时长", () => {
    for (const text of [
      "my office is in Clementi, somewhere close",
      "I work in Clementi, nearby would be nice",
      "Clementi is where I work, not too far please",
    ]) {
      const { patch } = validatePatch(
        { set: { commute: { destination: "Clementi", maxMinutes: 15 } } },
        VOCAB,
        {},
        text,
      );
      assert.equal(
        (patch.commute?.value as { maxMinutes?: number }).maxMinutes,
        undefined,
        `"${text}" 不该被当成时长`,
      );
    }
  });

  it("光有数字不算 —— 3-bedroom 里的 3 不是时长", () => {
    const { patch } = validatePatch(
      { set: { commute: { destination: "Clementi", maxMinutes: 20 } } },
      VOCAB,
      {},
      "We want a 3-bedroom condo near my Clementi office, budget $7,000",
    );
    assert.equal((patch.commute?.value as { maxMinutes?: number }).maxMinutes, undefined);
  });

  it("数字和单位连着写也算 —— 用户明说的条件不能被默认值顶掉", () => {
    // 真实翻车："30mins" 里 min 前面没有词边界，用户自己说的 30 分钟被丢掉，
    // 系统转而套用 40 分钟默认上限，结果比用户要的还宽
    for (const text of [
      "i'm a nus student, find me a room where i can go to school within 30mins",
      "20min to the office in Clementi is my limit",
      "about 1hr to Clementi is fine",
    ]) {
      const { patch } = validatePatch(
        { set: { commute: { destination: "Clementi", maxMinutes: 30 } } },
        VOCAB,
        {},
        text.includes("Clementi") ? text : `${text} — I study at Clementi`,
      );
      assert.equal((patch.commute?.value as { maxMinutes?: number }).maxMinutes, 30, text);
    }
  });

  it("min 是 administrator 的子串，但那不算时长", () => {
    const { patch } = validatePatch(
      { set: { commute: { destination: "Clementi", maxMinutes: 25 } } },
      VOCAB,
      {},
      "I work as an administrator in Clementi",
    );
    assert.equal((patch.commute?.value as { maxMinutes?: number }).maxMinutes, undefined);
  });

  it("「half an hour」算时长", () => {
    const { patch } = validatePatch(
      { set: { commute: { destination: "Clementi", maxMinutes: 30 } } },
      VOCAB,
      {},
      "I'd like to be within half an hour of the Clementi office",
    );
    assert.equal((patch.commute?.value as { maxMinutes: number }).maxMinutes, 30);
  });

  it("上一轮说过的值不用重新举证 —— 否则重提目的地会把时长弄丢", () => {
    const { patch } = validatePatch(
      { set: { commute: { destination: "Tampines", mode: "mrt", maxMinutes: 40 } } },
      VOCAB,
      { commute: { destination: "Clementi", mode: "mrt", maxMinutes: 40 } },
      "actually make it Tampines instead",
    );
    assert.deepEqual(patch.commute?.value, {
      destination: "Tampines",
      mode: "mrt",
      maxMinutes: 40,
    });
  });

  it("坐地铁、坐巴士、走路都认得出来", () => {
    const cases: Array<[string, string]> = [
      ["I take the MRT to work in Clementi", "mrt"],
      ["I go by bus to Clementi", "bus"],
      ["I walk to the office in Clementi", "walk"],
    ];
    for (const [text, mode] of cases) {
      const { patch } = validatePatch(
        { set: { commute: { destination: "Clementi", mode } } },
        VOCAB,
        {},
        text,
      );
      assert.equal((patch.commute?.value as { mode?: string }).mode, mode, text);
    }
  });
});
