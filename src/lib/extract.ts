/**
 * 需求抽取的**契约层** —— 定义模型该返回什么形状，以及怎么验它。
 *
 * 分工：
 *   LLM  负责理解（消歧、否定、指代、把 "NUS" 映射到语料里存在的片区）
 *   这里 负责校验（地点必须在闭集内、数字必须能 parse、槽位名必须合法）
 *
 * 纯函数，不发网络请求；真正的模型调用在 claude.ts。
 *
 * 曾经这里还有一套正则版抽取器，作为"API 挂了的降级路径"。删掉了 —— 那个理由
 * 站不住：生成回复同样依赖 API，抽取成功但答不出话，用户看到的仍然是坏掉的产品。
 * 而"省一次调用"也做不到：你没法事先知道正则抽全了没有（"不用能做饭了"会漏掉
 * 否定），漏了照样得调，不如一开始就调。真正干活的是下面的 validatePatch。
 */

import { NOTCH_STEP, type CommuteNeed, type SearchQuery } from "./search.ts";
import type { SlotKey, StatePatch } from "./state.ts";
import { canonicalize, type Vocab } from "./vocab.ts";

/**
 * 能做相对调整的槽位，以及"一档"怎么算。
 *
 * 步长来自 search.ts 的 NOTCH_STEP —— 和放宽建议共用同一组数字，
 * 否则用户会发现"我说再便宜点"和"系统建议放宽预算"的幅度对不上。
 *
 * up / down 是**用户视角的方向**，不是数值方向：
 *   "再便宜点" → budgetMax down → 数值变小
 *   "大一点"   → sizeSqftMin up → 数值变大
 *   "走远点也行" → maxWalkMinutes up → 数值变大（约束放宽）
 */
const ADJUSTMENTS: Partial<Record<SlotKey, (current: number, up: boolean) => number>> = {
  budgetMax: (v, up) => Math.round(v * (up ? 1 + NOTCH_STEP.budgetPct : 1 - NOTCH_STEP.budgetPct)),
  budgetMin: (v, up) => Math.round(v * (up ? 1 + NOTCH_STEP.budgetPct : 1 - NOTCH_STEP.budgetPct)),
  sizeSqftMin: (v, up) => Math.round(v * (up ? 1 + NOTCH_STEP.sizePct : 1 - NOTCH_STEP.sizePct)),
  maxWalkMinutes: (v, up) => v + (up ? NOTCH_STEP.walkMinutes : -NOTCH_STEP.walkMinutes),
  maxLeaseMinMonths: (v, up) =>
    up ? v * NOTCH_STEP.leaseFactor : Math.round(v / NOTCH_STEP.leaseFactor),
  bedroomsMin: (v, up) => v + (up ? 1 : -1),
  bathroomsMin: (v, up) => v + (up ? 1 : -1),
};

export const ADJUSTABLE_SLOTS = Object.keys(ADJUSTMENTS) as SlotKey[];

/**
 * 模型返回的形状。
 *
 * 刻意做成 set / clear / pin / inferred 四个平坦字段，而不是嵌套的
 * `{ slot: { value, confidence, source } }` —— 后者的 JSON schema 会因为
 * 每个槽位的值类型不同而变得极其冗长，模型也更容易填错结构。
 */
export type ExtractedPatch = {
  set?: Partial<{
    budgetMax: number;
    budgetMin: number;
    listingType: "room" | "whole_unit";
    propertyTypes: string[];
    bedroomsMin: number;
    bathroomsMin: number;
    sizeSqftMin: number;
    areas: string[];
    districts: string[];
    stations: string[];
    maxWalkMinutes: number;
    furnishing: string[];
    requireCooking: boolean;
    requirePet: boolean;
    requireAircon: boolean;
    requireUtilitiesIncluded: boolean;
    maxLeaseMinMonths: number;
    moveInBy: string;
    occupantType: string;
    directOwnerOnly: boolean;
    amenities: string[];
    tenantGender: string;
    /** 要去的地方（上班/上学），不是想住的地方 —— 见 CommuteNeed 的注释 */
    commute: { destination: string; mode?: string; maxMinutes?: number };
  }>;
  /** 用户明确取消的约束 */
  clear?: string[];
  /** 用户说了"必须 / 一定要"的约束 */
  pin?: string[];
  /** set 里哪些是推断的（而非用户明说）—— 决定能否覆盖已有原话 */
  inferred?: string[];
  /**
   * 相对调整："再便宜点"、"大一些"、"能走远点也行"。
   *
   * 模型只报**方向**，不报数字 —— 具体幅度由代码按固定档位算（见 NOTCH_STEP）。
   * 这么设计有三个好处：模型不用猜数（也就不存在"这个数是不是推断的"这种争议）、
   * 调整幅度和放宽建议全系统一致、结果完全确定因此可测。
   */
  adjust?: Array<{ slot: string; direction: "up" | "down" }>;
  /**
   * 「拿不准，得问一句」的出口。
   *
   * 用户说"我在 city 上班"时，city 可能是 Raffles Place、City Hall、
   * Tanjong Pagar、Marina Bay…… 模型挑一个锁死是最糟的选择 —— 用户根本
   * 不知道系统替他做了这个决定。这时候把槽位放进 ambiguous 并给出问题，
   * 该槽位这一轮就不会被写进状态，agent 会去问。
   */
  ambiguous?: Array<{ slot: string; question: string }>;
  /**
   * 用户明确表示"别问了，就按现在的条件给我看"。
   *
   * 没有这个信号时，系统会因为约束太少而一直追问 —— 用户说了
   * "just show me whatever you think is best" 却还被问第四遍，比问少了更糟。
   */
  wantsResultsNow?: boolean;
  /**
   * 用户**直接开口问**放宽的事："哪条最难满足？""我该让步什么？""怎么才能多点选择？"
   *
   * 系统平时不主动给放宽清单（那是替用户做决定），但他张口问了就必须给 ——
   * 而且答案是现成的：放宽每一条各能多出多少套，增量最大的那条就是最卡的那条。
   */
  wantsRelaxAdvice?: boolean;
  /** 地点解析的说明，给用户看："我是按 Clementi、Dover 一带找的" */
  locationNote?: string;
};

// 注意：这里没有 tenantNationality。
// 模型在 schema 层面就无法产出国籍偏好 —— 和检索层没有国籍过滤器是同一个决定，
// 只是把防线又往前推了一层：不是"不用"，是"表达不出来"。

const COMMUTE_MODES = ["mrt", "bus", "walk", "drive"];

/**
 * 出行方式的词面证据。用户没说过这些词，就不能说他指定了方式。
 */
const MODE_EVIDENCE: Record<string, RegExp> = {
  drive: /\b(driv\w*|car|cars|vehicle|motorbike|scooter)\b/i,
  mrt: /\b(mrt|train|subway|metro|rail|red line|east.west line|\w+ line)\b/i,
  bus: /\b(bus|buses)\b/i,
  walk: /\b(walk\w*|on foot|by foot|stroll\w*)\b/i,
};

/** 时长的词面证据 —— 必须出现时间单位，光有数字不算（"3-bedroom" 也有数字） */
const DURATION_EVIDENCE =
  /\b(min|mins|minute|minutes|hour|hours|hr|hrs|half an hour|quarter of an hour)\b/i;

/**
 * 通勤的**方式**和**时长上限**必须能在用户原话里找到依据。
 *
 * 起因是一次真实的编造：用户说 "the children will study around Bukit Timah,
 * so somewhere close would be great" —— 一个字都没提交通工具和时长，
 * 系统却抽出了 `by DRIVE, under 20 min`，而且两者都成了硬过滤条件。
 * 用户完全看不出这个 20 分钟是哪来的，也不知道自己被它挡掉了多少房源。
 *
 * 更麻烦的是这个编造是**间歇性的** —— 同一句话复现两次都正常。
 * 所以不能靠 prompt 里加一句"不要编造"，必须有代码层面的客观检验：
 * 和地点走闭集是同一个思路，模型可以提议，代码负责核对。
 *
 * 「已经存在且没变」的值不需要重新举证 —— 用户上一轮说过的条件会留在状态里，
 * 这一轮只是重提目的地时，不该把之前说好的时长弄丢。
 */
function evidenceFilter(
  need: CommuteNeed,
  userText: string,
  current: CommuteNeed | undefined,
): { need: CommuteNeed; dropped: Array<{ field: string; value: unknown }> } {
  const dropped: Array<{ field: string; value: unknown }> = [];
  const kept: CommuteNeed = { destination: need.destination };

  if (need.mode !== undefined) {
    const unchanged = current?.mode === need.mode;
    if (unchanged || MODE_EVIDENCE[need.mode]?.test(userText)) kept.mode = need.mode;
    else dropped.push({ field: "commute.mode", value: need.mode });
  }

  if (need.maxMinutes !== undefined) {
    const unchanged = current?.maxMinutes === need.maxMinutes;
    if (unchanged || DURATION_EVIDENCE.test(userText)) kept.maxMinutes = need.maxMinutes;
    else dropped.push({ field: "commute.maxMinutes", value: need.maxMinutes });
  }

  return { need: kept, dropped };
}

/**
 * 校验通勤对象。返回 CommuteNeed，或者一句失败原因（进 dropped）。
 *
 * destination 走的是**区域 ∪ 站名 ∪ 邮区的并集**：用户口中的目的地可能是
 * 公司所在的片区（"Raffles Place"）、也可能是个地铁站名，两者在这份数据里
 * 本来就大量重名。落不进闭集就整条丢掉 —— 一个编造的目的地比没有目的地更糟，
 * 它会显示在侧栏上，让用户以为系统听懂了。
 */
function parseCommute(value: unknown, vocab: Vocab): CommuteNeed | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "commute is not an object";
  }
  const raw = value as Record<string, unknown>;

  if (typeof raw.destination !== "string") return "commute.destination is missing";
  const places = [...vocab.areas, ...vocab.stations, ...vocab.districts];
  const destination = canonicalize(raw.destination, places);
  if (destination === null) return "commute.destination is not in the closed vocabulary";

  const need: CommuteNeed = { destination };

  if (raw.mode !== undefined) {
    const mode = typeof raw.mode === "string" ? raw.mode.toLowerCase() : null;
    // 方式认不出就只丢这个字段，目的地仍然保留 —— 部分信息比零信息有用
    if (mode !== null && COMMUTE_MODES.includes(mode)) {
      need.mode = mode as CommuteNeed["mode"];
    }
  }

  if (raw.maxMinutes !== undefined) {
    if (typeof raw.maxMinutes === "number" && Number.isFinite(raw.maxMinutes) && raw.maxMinutes > 0) {
      need.maxMinutes = raw.maxMinutes;
    }
  }

  return need;
}

const PROPERTY_TYPES = ["HDB", "Condominium", "Landed", "Serviced Apartment"];
const FURNISHING = ["fully", "partial", "unfurnished"];
const GENDERS = ["male", "female"];

const NUMBER_SLOTS = new Set<SlotKey>([
  "budgetMax",
  "budgetMin",
  "bedroomsMin",
  "bathroomsMin",
  "sizeSqftMin",
  "maxWalkMinutes",
  "maxLeaseMinMonths",
]);

const BOOLEAN_SLOTS = new Set<SlotKey>([
  "requireCooking",
  "requirePet",
  "requireAircon",
  "requireUtilitiesIncluded",
  "directOwnerOnly",
]);

/** 所有合法槽位。模型返回任何不在这里的键都会被丢弃 */
export const EXTRACTABLE_SLOTS: SlotKey[] = [
  "budgetMax",
  "budgetMin",
  "listingType",
  "propertyTypes",
  "bedroomsMin",
  "bathroomsMin",
  "sizeSqftMin",
  "areas",
  "districts",
  "stations",
  "maxWalkMinutes",
  "furnishing",
  "requireCooking",
  "requirePet",
  "requireAircon",
  "requireUtilitiesIncluded",
  "maxLeaseMinMonths",
  "moveInBy",
  "occupantType",
  "directOwnerOnly",
  "amenities",
  "tenantGender",
  "commute",
];

// ---------------------------------------------------------------------------
// JSON schema —— 闭集在运行时注入
// ---------------------------------------------------------------------------

/**
 * 抽取结果的 schema。
 *
 * **大闭集（46 个区域 + 85 个站名 + 27 个邮区）刻意不写进 enum。**
 * 试过了：170 多个枚举值会让 API 报 "Schema is too complex" —— 结构化输出要把
 * schema 编译成语法约束，枚举值太多就编译不动。所以分工是：
 *   schema        管形状和小枚举（出租类型、物业类型、家具、性别）
 *   system prompt 列出大闭集，让模型知道能选什么（稳定前缀，走缓存）
 *   validatePatch 兜底，越界的值一律丢弃
 * 第三道才是真正的强制力 —— 前两道是让模型更容易做对，不是安全边界。
 */
export function buildPatchSchema(_vocab: Vocab): Record<string, unknown> {
  const num = { type: "number" };
  const bool = { type: "boolean" };
  const stringArray = { type: "array", items: { type: "string" } };
  const enumArray = (values: string[]) => ({
    type: "array",
    items: { type: "string", enum: values },
  });

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      set: {
        type: "object",
        additionalProperties: false,
        properties: {
          budgetMax: num,
          budgetMin: num,
          listingType: { type: "string", enum: ["room", "whole_unit"] },
          propertyTypes: enumArray(PROPERTY_TYPES),
          bedroomsMin: num,
          bathroomsMin: num,
          sizeSqftMin: num,
          areas: stringArray,
          districts: stringArray,
          stations: stringArray,
          maxWalkMinutes: num,
          furnishing: enumArray(FURNISHING),
          requireCooking: bool,
          requirePet: bool,
          requireAircon: bool,
          requireUtilitiesIncluded: bool,
          maxLeaseMinMonths: num,
          moveInBy: { type: "string" },
          occupantType: { type: "string" },
          directOwnerOnly: bool,
          amenities: stringArray,
          tenantGender: { type: "string", enum: GENDERS },
          commute: {
            type: "object",
            additionalProperties: false,
            properties: {
              destination: { type: "string" },
              mode: { type: "string", enum: COMMUTE_MODES },
              maxMinutes: num,
            },
            required: ["destination"],
          },
        },
      },
      clear: stringArray,
      pin: stringArray,
      inferred: stringArray,
      adjust: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            slot: { type: "string", enum: [...ADJUSTABLE_SLOTS] },
            direction: { type: "string", enum: ["up", "down"] },
          },
          required: ["slot", "direction"],
        },
      },
      ambiguous: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            slot: { type: "string" },
            question: { type: "string" },
          },
          required: ["slot", "question"],
        },
      },
      wantsResultsNow: { type: "boolean" },
      wantsRelaxAdvice: { type: "boolean" },
      locationNote: { type: "string" },
    },
    // 结构化输出限制**可选**参数最多 24 个，而 set 里就有 22 个。
    // 把顶层字段全设为必填（模型传空对象／空数组／空串即可），
    // 可选计数就只剩 set 的 22 个，留出了加槽位的余地。
    required: [
      "set",
      "clear",
      "pin",
      "inferred",
      "adjust",
      "ambiguous",
      "wantsResultsNow",
      "wantsRelaxAdvice",
      "locationNote",
    ],
  };
}

// ---------------------------------------------------------------------------
// 校验：任何来源的 patch 都要过这一关
// ---------------------------------------------------------------------------

export type ValidationResult = {
  patch: StatePatch;
  /** 被丢弃的内容及原因 —— 进日志，用于发现模型的系统性错误 */
  dropped: Array<{ slot: string; value: unknown; reason: string }>;
  /** 模型表示拿不准、需要问用户的槽位 */
  ambiguous: Array<{ slot: string; question: string }>;
  /** 用户说"别问了，直接给我看" */
  wantsResultsNow: boolean;
  /** 用户直接开口问该放宽哪一条 */
  wantsRelaxAdvice: boolean;
  locationNote?: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 把任意来源的抽取结果转成可信的 StatePatch。
 *
 * 结构化输出已经约束了形状，但这一层仍然必须存在：schema 保证不了跨字段的合理性
 * （负数预算、日期格式、模型偶尔的越界），而检索层拿到脏值会静默返回错误结果。
 */
export function validatePatch(
  raw: unknown,
  vocab: Vocab,
  /** 当前状态 —— 相对调整（"再便宜点"）要拿它算出具体数值 */
  current: SearchQuery = {},
  /**
   * 用户这一轮的原话。用来核对通勤的方式和时长是不是他真说过的 ——
   * 模型偶尔会凭空补出 "by DRIVE, under 20 min"，而这两个都是硬过滤条件。
   * 默认空串意味着"无从核对"，此时一律要求举证，宁可丢也不编。
   */
  userText = "",
): ValidationResult {
  const dropped: ValidationResult["dropped"] = [];
  const patch: StatePatch = {};

  if (typeof raw !== "object" || raw === null) {
    return {
      patch,
      dropped: [{ slot: "*", value: raw, reason: "not an object" }],
      ambiguous: [],
      wantsResultsNow: false,
      wantsRelaxAdvice: false,
    };
  }

  const input = raw as ExtractedPatch;
  const inferred = new Set(input.inferred ?? []);
  const pinned = new Set(input.pin ?? []);

  // 模型说拿不准的槽位：这一轮不写进状态，交给 agent 去问。
  // 模型有时会一边标 ambiguous 一边给个猜测值 —— 那个猜测值正是问题所在，丢掉。
  const ambiguous = (input.ambiguous ?? []).filter(
    (a) =>
      typeof a?.slot === "string" &&
      typeof a?.question === "string" &&
      a.question.trim() !== "" &&
      EXTRACTABLE_SLOTS.includes(a.slot as SlotKey),
  );
  const unresolved = new Set(ambiguous.map((a) => a.slot));

  const closedSets: Partial<Record<SlotKey, string[]>> = {
    areas: vocab.areas,
    districts: vocab.districts,
    stations: vocab.stations,
    amenities: vocab.amenities,
    occupantType: vocab.occupantTypes,
    propertyTypes: PROPERTY_TYPES,
    furnishing: FURNISHING,
    listingType: ["room", "whole_unit"],
    tenantGender: GENDERS,
  };

  for (const [rawSlot, value] of Object.entries(input.set ?? {})) {
    const slot = rawSlot as SlotKey;

    if (!EXTRACTABLE_SLOTS.includes(slot)) {
      dropped.push({ slot: rawSlot, value, reason: "unknown slot" });
      continue;
    }

    if (unresolved.has(slot)) {
      dropped.push({ slot, value, reason: "model flagged it as uncertain — not applied, asking the user instead" });
      continue;
    }

    let normalized: unknown = value;

    if (NUMBER_SLOTS.has(slot)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        dropped.push({ slot, value, reason: "not a positive number" });
        continue;
      }
    } else if (BOOLEAN_SLOTS.has(slot)) {
      if (typeof value !== "boolean") {
        dropped.push({ slot, value, reason: "not a boolean" });
        continue;
      }
    } else if (slot === "moveInBy") {
      if (typeof value !== "string" || !DATE_RE.test(value)) {
        dropped.push({ slot, value, reason: "not a YYYY-MM-DD date" });
        continue;
      }
    } else if (slot === "commute") {
      const parsed = parseCommute(value, vocab);
      if (typeof parsed === "string") {
        dropped.push({ slot, value, reason: parsed });
        continue;
      }
      // 目的地过闭集，方式和时长过词面证据 —— 两道都是客观检验，不靠模型自律
      const checked = evidenceFilter(parsed, userText, current.commute);
      for (const item of checked.dropped) {
        dropped.push({
          slot: item.field,
          value: item.value,
          reason: "not stated by the user — no wording in their message supports it",
        });
      }
      normalized = checked.need;
    } else if (Array.isArray(value)) {
      // 闭集数组：逐项归一化，越界项单独丢弃而不是整条丢掉
      const allowed = closedSets[slot];
      const kept: string[] = [];
      for (const item of value) {
        const canonical =
          allowed && typeof item === "string" ? canonicalize(item, allowed) : null;
        if (canonical === null) {
          dropped.push({ slot, value: item, reason: "not in the closed vocabulary" });
        } else {
          kept.push(canonical);
        }
      }
      if (kept.length === 0) continue;
      normalized = kept;
    } else if (typeof value === "string") {
      const allowed = closedSets[slot];
      const canonical = allowed ? canonicalize(value, allowed) : value;
      if (canonical === null) {
        dropped.push({ slot, value, reason: "not in the closed vocabulary" });
        continue;
      }
      normalized = canonical;
    } else {
      dropped.push({ slot, value, reason: "unsupported type" });
      continue;
    }

    patch[slot] = {
      value: normalized,
      source: inferred.has(slot) ? "inferred" : "stated",
      ...(pinned.has(slot) ? { pinned: true } : {}),
    };
  }

  // --- 相对调整：模型只给方向，数值由固定档位算出来 -------------------------
  for (const { slot: rawSlot, direction } of input.adjust ?? []) {
    const slot = rawSlot as SlotKey;
    const step = ADJUSTMENTS[slot];

    if (!step) {
      dropped.push({ slot: rawSlot, value: direction, reason: "slot does not support relative adjustment" });
      continue;
    }
    // 同轮给了具体数值就以数值为准 —— 用户说"最多 1000"比"再便宜点"精确
    if (patch[slot] !== undefined) {
      dropped.push({ slot, value: direction, reason: "an explicit value was given this turn — relative adjustment ignored" });
      continue;
    }

    const base = current[slot];
    if (typeof base !== "number") {
      // 没有原值就无从"再便宜"。不要瞎猜一个基准 —— 让 agent 去问用户。
      dropped.push({ slot, value: direction, reason: "no existing value to adjust from" });
      continue;
    }

    const next = step(base, direction === "up");
    if (!Number.isFinite(next) || next <= 0) {
      dropped.push({ slot, value: next, reason: "adjusted value is not positive" });
      continue;
    }

    // 来源是 stated：用户**明确要求**了这次调整，只是把算数交给了我们。
    // 标成 inferred 会被状态层的"推断不得覆盖原话"规则拦掉 —— 实测踩过这个坑。
    patch[slot] = { value: next, source: "stated" };
  }

  // 清除指令：只认合法槽位
  for (const rawSlot of input.clear ?? []) {
    const slot = rawSlot as SlotKey;
    if (!EXTRACTABLE_SLOTS.includes(slot)) {
      dropped.push({ slot: rawSlot, value: null, reason: "unknown slot (clear)" });
      continue;
    }
    // 同一个槽位既在 set 又在 clear 里时，set 赢。
    // 模型表达"换成另一个值"时经常会同时给出两者（先清掉旧的，再设新的），
    // 如果 clear 后处理就会把新值抹掉 —— 用户看到的是"区域没了"而不是"区域变了"。
    if (patch[slot] !== undefined) {
      dropped.push({ slot, value: null, reason: "a new value was set this turn — clear ignored, treated as replacement" });
      continue;
    }
    patch[slot] = { value: null };
  }

  return {
    patch,
    dropped,
    ambiguous,
    wantsResultsNow: input.wantsResultsNow === true,
    wantsRelaxAdvice: input.wantsRelaxAdvice === true,
    ...(input.locationNote ? { locationNote: input.locationNote } : {}),
  };
}
