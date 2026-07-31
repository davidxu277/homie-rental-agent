/**
 * 对话状态 —— 一份显式的、结构化的需求档案。
 *
 * 多轮对话的核心不是"把历史消息塞给模型"，而是维护一份可检查、可展示、可回滚的
 * 需求状态。模型每轮只负责产出一个 **patch**（只含变化的槽位），归并由这里的纯函数
 * 完成 —— 这样状态演化是确定的、可测试的，出问题时能立刻分清是抽取错了还是归并错了。
 *
 * 值本身直接复用检索层的 SearchQuery，不另立一套字段定义：
 * 状态里能存的，就是检索能用的，字段改名会在编译期报错。
 */

import type { CleanListing } from "./types.ts";
import { searchListings, type SearchQuery } from "./search.ts";

export type SlotKey = keyof SearchQuery;

/**
 * stated   用户明说的（"预算 850"）
 * inferred 从上下文推断的（提到"合租室友" → 大概率是单间）
 */
export type SlotSource = "stated" | "inferred";

export type SlotMeta = {
  /** 最后一次被写入是第几轮 —— 让"哪些是新说的"可判断 */
  turnSet: number;
  /** 0-1。推断值必须低于明说值，否则会反过来覆盖用户的原话 */
  confidence: number;
  source: SlotSource;
  /** 用户说过"必须 / 一定要"。底线约束，放宽推演永远不碰 */
  pinned: boolean;
};

export type RequirementState = {
  values: SearchQuery;
  meta: Partial<Record<SlotKey, SlotMeta>>;
  turn: number;
};

export function emptyState(): RequirementState {
  return { values: {}, meta: {}, turn: 0 };
}

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

export type SlotUpdate = {
  /** null 表示**明确清除**这个槽位；不出现在 patch 里才表示"这轮没提到" */
  value: unknown;
  confidence?: number;
  source?: SlotSource;
  pinned?: boolean;
};

/** 模型每轮的产出。只含变化的槽位 —— 没提到的槽位保持原样，这是"改主意"不误伤的关键 */
export type StatePatch = Partial<Record<SlotKey, SlotUpdate>>;

export const DEFAULT_CONFIDENCE: Record<SlotSource, number> = {
  stated: 1,
  inferred: 0.5,
};

export type ChangeKind = "set" | "updated" | "cleared" | "pinned" | "rejected";

export type StateChange = {
  slot: SlotKey;
  kind: ChangeKind;
  from: unknown;
  to: unknown;
  /** 给用户看的一句话。让状态变更可复述 —— 用户要能看见 agent 理解对了 */
  description: string;
};

function render(value: unknown): string {
  if (value === undefined || value === null) return "not set";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

const SLOT_LABELS: Partial<Record<SlotKey, string>> = {
  budgetMax: "Max budget",
  budgetMin: "Min budget",
  listingType: "Rental type",
  propertyTypes: "Property type",
  bedroomsMin: "Bedrooms",
  bathroomsMin: "Bathrooms",
  sizeSqftMin: "Min size",
  areas: "Areas",
  districts: "Districts",
  stations: "MRT stations",
  maxWalkMinutes: "Walk to MRT",
  furnishing: "Furnishing",
  requireCooking: "Cooking allowed",
  requirePet: "Pet-friendly",
  requireAircon: "Air-conditioning",
  requireUtilitiesIncluded: "Utilities included",
  maxLeaseMinMonths: "Longest lease you'll sign",
  moveInBy: "Move-in by",
  occupantType: "Occupant type",
  directOwnerOnly: "Direct owner only",
  amenities: "Amenities",
  tenantGender: "Tenant gender",
  tenantNationality: "Tenant nationality",
};

export function slotLabel(slot: SlotKey): string {
  return SLOT_LABELS[slot] ?? slot;
}

/**
 * 归并一个 patch，返回新状态和变更清单。
 *
 * 纯函数：不修改传入的 state。变更清单让 agent 能明确复述
 * （"已把区域从东部改为西部，预算和做饭要求保持不变"），
 * 用户由此能看见状态确实更新对了，而不是被悄悄改掉或悄悄忽略。
 */
export function applyPatch(
  state: RequirementState,
  patch: StatePatch,
): { state: RequirementState; changes: StateChange[] } {
  const turn = state.turn + 1;
  const values: SearchQuery = { ...state.values };
  const meta: Partial<Record<SlotKey, SlotMeta>> = { ...state.meta };
  const changes: StateChange[] = [];

  for (const [rawSlot, update] of Object.entries(patch)) {
    const slot = rawSlot as SlotKey;
    if (update === undefined) continue;

    const previous = values[slot];
    const previousMeta = meta[slot];
    const source: SlotSource = update.source ?? "stated";
    const confidence = update.confidence ?? DEFAULT_CONFIDENCE[source];

    // 推断值不得覆盖用户明说过的内容。
    // 模型很容易从上下文"顺手"推出一个值，如果它能盖掉原话，用户会发现自己说过的
    // 条件莫名其妙变了 —— 这是多轮对话里最难排查、也最伤信任的一类 bug。
    if (
      previousMeta !== undefined &&
      previousMeta.source === "stated" &&
      source === "inferred" &&
      confidence < previousMeta.confidence
    ) {
      changes.push({
        slot,
        kind: "rejected",
        from: previous,
        to: update.value,
        description: `${slotLabel(slot)}: kept what you told me ("${render(previous)}"), ignored the inferred value ("${render(update.value)}")`,
      });
      continue;
    }

    if (update.value === null) {
      if (previous === undefined) continue;
      delete values[slot];
      delete meta[slot];
      changes.push({
        slot,
        kind: "cleared",
        from: previous,
        to: null,
        description: `${slotLabel(slot)}: removed (was ${render(previous)})`,
      });
      continue;
    }

    // biome-ignore lint: 槽位类型由 SearchQuery 保证，此处是动态写入
    (values as Record<string, unknown>)[slot] = update.value;
    meta[slot] = {
      turnSet: turn,
      confidence,
      source,
      pinned: update.pinned ?? previousMeta?.pinned ?? false,
    };

    const unchanged = JSON.stringify(previous) === JSON.stringify(update.value);
    if (previous === undefined) {
      changes.push({
        slot,
        kind: "set",
        from: undefined,
        to: update.value,
        description: `${slotLabel(slot)}: ${render(update.value)}`,
      });
    } else if (!unchanged) {
      changes.push({
        slot,
        kind: "updated",
        from: previous,
        to: update.value,
        description: `${slotLabel(slot)}: changed from ${render(previous)} to ${render(update.value)}`,
      });
    }

    if (update.pinned && !previousMeta?.pinned) {
      changes.push({
        slot,
        kind: "pinned",
        from: previous,
        to: update.value,
        description: `${slotLabel(slot)} marked as a hard requirement — it won't be suggested for relaxing`,
      });
    }
  }

  return { state: { values, meta, turn }, changes };
}

// ---------------------------------------------------------------------------
// 派生视图
// ---------------------------------------------------------------------------

/** 剥掉元信息，交给检索层 */
export function toSearchQuery(state: RequirementState): SearchQuery {
  return { ...state.values };
}

/** 用户明说"必须"的槽位 —— 直接喂给 computeRelaxations 的 keep */
export function pinnedSlots(state: RequirementState): SlotKey[] {
  return (Object.keys(state.meta) as SlotKey[]).filter((slot) => state.meta[slot]?.pinned);
}

/**
 * 靠推断得来、还没被用户确认过的槽位。
 * 这些值可以用来出结果，但 agent 应该在下一轮找机会确认，不能当既定事实。
 */
export function unconfirmedSlots(state: RequirementState, threshold = 1): SlotKey[] {
  return (Object.keys(state.meta) as SlotKey[]).filter(
    (slot) => (state.meta[slot]?.confidence ?? 0) < threshold,
  );
}

/** 这一轮发生变化的槽位 */
export function slotsChangedOnTurn(state: RequirementState, turn: number): SlotKey[] {
  return (Object.keys(state.meta) as SlotKey[]).filter((slot) => state.meta[slot]?.turnSet === turn);
}

// ---------------------------------------------------------------------------
// 兜底追问
// ---------------------------------------------------------------------------

/**
 * 这一节解决的是一个**边缘情况**，不是主流程。
 *
 * 主流程永远是：用户说话 → 抽取关键词 → 检索 → 回答他问的东西。
 * agent 的职责是响应用户，不是拿着问卷逐项盘问 —— 连着问三轮却一条房源都没给，
 * 那不是对话，是把表单拆成了几句话。
 *
 * 只有一种情况需要主动开口：用户说的话里**实在抽不出任何能用来筛选的东西**
 * （"我想租房"），此时检索没有意义，必须先拿到一点信息。即便如此也只问一句，
 * 而且要挑最能切开候选集的那一句。
 */

/**
 * 有了这么多条有效约束就不该再追问了 —— 直接给结果，让用户对着真实房源反应，
 * 比继续盘问高效得多。用户看到具体的房子才知道自己在意什么。
 */
const MIN_CONSTRAINTS_TO_SEARCH = 2;

/** 不参与"够不够筛选"计数：它们是保护性/展示性字段，不构成用户的找房需求 */
const NON_NARROWING_SLOTS = new Set<SlotKey>(["tenantGender", "tenantNationality"]);

/** 状态里有几条真正能用来筛选的约束 */
export function constraintCount(state: RequirementState): number {
  return (Object.keys(state.values) as SlotKey[]).filter((slot) => !NON_NARROWING_SLOTS.has(slot))
    .length;
}

/** 是否薄到无法检索 —— 只有这时才该主动开口 */
export function needsClarification(state: RequirementState): boolean {
  return constraintCount(state) < MIN_CONSTRAINTS_TO_SEARCH;
}

/**
 * 每个可探询的槽位：领域先验权重 + 从房源上取出对应 facet 的函数。
 *
 * 先验反映的是通用租房常识（预算永远比"要不要空调"重要），
 * 不针对任何具体用户。真正决定问哪句的是它乘以**当前候选集上的区分度**。
 */
type SlotProbe = {
  slot: SlotKey;
  prior: number;
  question: string;
  facet: (listing: CleanListing) => string | number | boolean | null;
};

const PROBES: SlotProbe[] = [
  { slot: "budgetMax", prior: 1.0, question: "What's your monthly budget, roughly?", facet: (l) => l.monthlyRentSgd },
  { slot: "listingType", prior: 0.95, question: "Are you after a whole unit, or just a room?", facet: (l) => l.listingType },
  { slot: "areas", prior: 0.9, question: "Any area you have in mind? Or where do you work or study?", facet: (l) => l.area },
  { slot: "moveInBy", prior: 0.7, question: "When do you need to move in?", facet: (l) => l.availableFrom },
  { slot: "maxLeaseMinMonths", prior: 0.6, question: "How long are you looking to stay?", facet: (l) => l.leaseMinMonths },
  { slot: "propertyTypes", prior: 0.55, question: "Any preference on property type — HDB, condo, or serviced apartment?", facet: (l) => l.propertyType },
  { slot: "bedroomsMin", prior: 0.5, question: "How many bedrooms do you need?", facet: (l) => l.bedrooms },
  { slot: "requireCooking", prior: 0.45, question: "Do you need to be able to cook?", facet: (l) => l.cookingAllowed },
  { slot: "requirePet", prior: 0.4, question: "Any pets moving in with you?", facet: (l) => l.petFriendly },
  { slot: "furnishing", prior: 0.35, question: "Do you need it furnished?", facet: (l) => l.furnishing },
  { slot: "sizeSqftMin", prior: 0.3, question: "Any minimum size you need?", facet: (l) => l.sizeSqft },
  { slot: "maxWalkMinutes", prior: 0.3, question: "How far from an MRT station are you willing to walk?", facet: (l) => l.nearestMrt?.walkMinutes ?? null },
  { slot: "requireUtilitiesIncluded", prior: 0.2, question: "Would you like utilities included in the rent?", facet: (l) => l.utilitiesIncluded },
];

/**
 * 候选集上的区分度：问这个问题能把结果切开多少。
 *
 * 如果剩下的房源在某个字段上取值几乎一致，问它就是浪费用户一轮 ——
 * 比如候选全都允许做饭，那"需要能做饭吗"这个问题的信息量是 0。
 */
function discrimination(values: Array<string | number | boolean | null>): number {
  const known = values.filter((v) => v !== null);
  if (known.length < 2) return 0;

  if (typeof known[0] === "number") {
    const numbers = known as number[];
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    if (mean === 0) return 0;
    const variance = numbers.reduce((sum, n) => sum + (n - mean) ** 2, 0) / numbers.length;
    // 变异系数：离散程度相对于量级，跨字段可比
    return Math.min(1, Math.sqrt(variance) / Math.abs(mean));
  }

  // 归一化熵：取值越均匀，问出来越能切分候选
  const counts = new Map<string, number>();
  for (const v of known) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  if (counts.size < 2) return 0;

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / known.length;
    entropy -= p * Math.log2(p);
  }
  return entropy / Math.log2(counts.size);
}

export type Clarification = {
  slot: SlotKey;
  question: string;
  /** prior × 区分度 */
  value: number;
  /** 当前候选集在这个字段上的区分度，0 表示问了也白问 */
  discrimination: number;
};

export type ClarifyOptions = {
  /** 候选已经足够少时不再追问 —— 直接给结果比继续盘问有价值 */
  stopWhenAtMost?: number;
  /** 强制追问，即使约束数已够。留给"用户主动说'你问我吧'"这类情况 */
  force?: boolean;
};

/**
 * 抽取不出足够信息时，该问的**那一句**。
 *
 * 返回单个问题而不是列表，是刻意的：连问两个就已经像在填表了。
 * 约束数够了就返回 null —— 那时候该做的是给结果，让用户对着真实房源反应，
 * 用户看到具体的房子才知道自己在意什么。
 *
 * 挑哪一句由「还空着哪些槽位」×「问了能切开多少当前候选」决定：
 * 如果剩下的房源在某字段上取值几乎一致，问它就是浪费用户一轮。
 */
export function clarifyingQuestion(
  listings: CleanListing[],
  state: RequirementState,
  options: ClarifyOptions = {},
): Clarification | null {
  if (!options.force && !needsClarification(state)) return null;

  const stopWhenAtMost = options.stopWhenAtMost ?? 3;
  const result = searchListings(listings, toSearchQuery(state), { limit: 10_000 });
  if (result.total <= stopWhenAtMost) return null;

  const candidates = result.hits.map((h) => h.listing);

  const ranked = PROBES.filter((probe) => state.values[probe.slot] === undefined)
    .map((probe) => {
      const spread = discrimination(candidates.map(probe.facet));
      return {
        slot: probe.slot,
        question: probe.question,
        value: probe.prior * spread,
        discrimination: spread,
      };
    })
    .filter((s) => s.discrimination > 0)
    .sort((a, b) => b.value - a.value || a.slot.localeCompare(b.slot));

  return ranked[0] ?? null;
}
