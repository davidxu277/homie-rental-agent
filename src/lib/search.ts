/**
 * 检索与打分引擎 —— 纯确定性，不调用任何模型。
 *
 * 500 条数据规模下不需要向量库：全量在内存里过一遍是毫秒级的。上向量检索反而带来
 * embedding 成本、召回不可解释、且无法精确处理"预算 ≤ X"这类数值约束。
 *
 * 三段式：
 *   1. 硬过滤   不可协商的条件，逐条约束独立计数，为放宽推演提供依据
 *   2. 软打分   加权求和，每一项的得分和权重都能单独取出 —— 这是推荐理由的原材料
 *   3. 放宽推演 单独的函数，不在检索时自动执行（什么时候讲给用户听是产品决策）
 *
 * 约束的划分依据是字段本身的性质，不是任何具体用户场景：
 *   - 预算上限、布尔型必需项、日期、租期 —— 越界即不可用，是硬约束
 *   - 面积、通勤、家具、设施         —— 越界只是变差，是软偏好（除非用户明确要求）
 */

import type { CleanListing, Furnishing, ListingType, PropertyType } from "./types.ts";

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/**
 * 用户要**去**的地方，以及他愿意花多久。
 *
 * 和 areas / stations 的区别是根本性的：那两个说的是"房子在哪"，
 * 这个说的是"你每天要去哪"。"I work near Raffles Place, under 40 min by MRT"
 * 里三个成分（目的地 / 方式 / 容忍度）在住址型槽位里一个都放不下 ——
 * 硬塞的结果是把目的地当成住址锚点，反而把一个几乎不排除任何东西的要求
 * 变成了整个查询里最紧的一条。
 */
export type CommuteNeed = {
  /** 目的地，取自闭集（区域名或站名） */
  destination: string;
  mode?: "mrt" | "bus" | "walk" | "drive";
  /** 用户愿意接受的单程分钟数 */
  maxMinutes?: number;
};

export type SearchQuery = {
  /** 月租上限（含）。超出即排除 —— 预算是租房里最典型的硬约束 */
  budgetMax?: number;
  /** 月租下限，用于"太便宜反而可疑"的场景，通常不填 */
  budgetMin?: number;

  listingType?: ListingType;
  propertyTypes?: PropertyType[];
  bedroomsMin?: number;
  bathroomsMin?: number;

  /** 面积下限。房源面积缺失时不参与该项筛选 —— 缺失不等于不满足 */
  sizeSqftMin?: number;

  /** 地点约束：三者是「或」的关系，命中任意一个即可 */
  areas?: string[];
  districts?: string[];
  stations?: string[];

  /**
   * 到最近地铁站的**步行**分钟上限。站点信息缺失时不参与筛选。
   *
   * 只对应"走 X 分钟能到地铁"这一种说法。"坐地铁 X 分钟到某地"是通勤，
   * 归 commute —— 早先两者混用过，40 分钟的通勤容忍度被写进这里，
   * 结果是 494 套全部通过（等于空转），真正清零结果的是被同时写进
   * stations 的目的地。
   */
  maxWalkMinutes?: number;

  /**
   * 通勤需求。**不参与筛选，也不参与打分。**
   *
   * 数据里 nearestMrt 只有 station / line / walkMinutes，没有任何站间行程时间，
   * 所以"坐地铁 40 分钟到 Raffles Place"在这份数据上不可计算。同线与否不能当代理：
   * EWL 上的 Pasir Ris 离 CBD 很远，DTL 上隔三站的地方反而近 ——
   * 那种启发式会产出"看着有依据其实是错的"推荐，比不筛更糟。
   *
   * 记下来有三个用处：不再被硬塞进住址槽位、侧栏能如实展示、
   * agent 能明说这条做不到。将来接入行程时间数据，它直接变成过滤器。
   */
  commute?: CommuteNeed;

  furnishing?: Furnishing[];
  requireCooking?: boolean;
  requirePet?: boolean;
  requireAircon?: boolean;
  requireUtilitiesIncluded?: boolean;

  /**
   * 用户最多愿意签多长的租期。
   * 注意方向：房源的 leaseMinMonths 是「最短」租期，短租需求要筛 leaseMinMonths ≤ 该值。
   */
  maxLeaseMinMonths?: number;

  /** 必须在这一天之前可入住（YYYY-MM-DD） */
  moveInBy?: string;

  occupantType?: string;
  /** true = 只看直接房东，省中介费 */
  directOwnerOnly?: boolean;
  /** 需要的设施，全部命中才算通过 */
  amenities?: string[];

  /**
   * 租客自己的性别，用于**排除会拒绝该租客的房源**，避免白跑一趟。
   * 这是保护性筛选，不是"只给我看某个性别的室友"。
   */
  tenantGender?: string;

  /**
   * 租客自己的国籍。**只用于生成提示，绝不参与筛选或排序。**
   * 排他性国籍偏好不作为可检索维度 —— 检索层根本没有这个 filter 可以调用。
   * 但房源带限制而租客不符合时要主动提示，这是正当且必要的信息披露。
   */
  tenantNationality?: string;
};

/** 打分维度的权重。调权重只改这里，不动打分逻辑 */
export type ScoreWeights = {
  budgetFit: number;
  commute: number;
  size: number;
  furnishing: number;
  amenities: number;
  freshness: number;
  availability: number;
};

export const DEFAULT_WEIGHTS: ScoreWeights = {
  // 和通勤持平，不再一家独大 —— 预算只是"别超"，不该主导排序
  budgetFit: 2,
  commute: 2,
  size: 1.5,
  furnishing: 1,
  amenities: 1,
  freshness: 0.5,
  availability: 0.5,
};

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

export type ScoreComponent = {
  dimension: keyof ScoreWeights;
  /** 0-1 的原始得分；null = 该维度不适用（用户没提，或房源没数据） */
  raw: number | null;
  weight: number;
  weighted: number;
  /** 得分来源，用于生成推荐理由。永远引用具体字段值，不做定性评价 */
  evidence: string;
};

export type ScoredListing = {
  listing: CleanListing;
  /** 0-1 归一化后的总分 */
  score: number;
  breakdown: ScoreComponent[];
  /** 命中的硬约束，可直接用于"✓ 预算内 ✓ 允许做饭" */
  matched: string[];
  /** 必须向用户披露的事项：数据缺失、房东限制等 */
  caveats: string[];
};

export type SearchResult = {
  hits: ScoredListing[];
  /** 通过硬过滤的总数（hits 可能被 limit 截断） */
  total: number;
  /** 每条约束单独砍掉了多少房源 —— 放宽推演的依据，也便于排查"为什么是 0 条" */
  excludedBy: Record<string, number>;
  /** 参与筛选的基数（可推荐的房源总数） */
  pool: number;
};

// ---------------------------------------------------------------------------
// 硬过滤
// ---------------------------------------------------------------------------

type Predicate = {
  /** 约束名，同时是放宽推演里的 key */
  key: string;
  test: (listing: CleanListing) => boolean;
  /** 命中时展示给用户的短语 */
  label: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function buildPredicates(query: SearchQuery): Predicate[] {
  const predicates: Predicate[] = [];

  if (query.budgetMax !== undefined) {
    const max = query.budgetMax;
    predicates.push({
      key: "budgetMax",
      label: `Under $${max.toLocaleString()}/mo`,
      // 租金为 null 的房源已经被推荐池挡在外面，这里不会遇到
      test: (l) => l.monthlyRentSgd !== null && l.monthlyRentSgd <= max,
    });
  }

  if (query.budgetMin !== undefined) {
    const min = query.budgetMin;
    predicates.push({
      key: "budgetMin",
      label: `At least $${min.toLocaleString()}/mo`,
      test: (l) => l.monthlyRentSgd !== null && l.monthlyRentSgd >= min,
    });
  }

  if (query.listingType !== undefined) {
    const wanted = query.listingType;
    predicates.push({
      key: "listingType",
      label: wanted === "room" ? "Room rental" : "Whole unit",
      test: (l) => l.listingType === wanted,
    });
  }

  if (query.propertyTypes?.length) {
    const wanted = new Set(query.propertyTypes);
    predicates.push({
      key: "propertyTypes",
      label: `${query.propertyTypes.join(" / ")}`,
      test: (l) => wanted.has(l.propertyType),
    });
  }

  if (query.bedroomsMin !== undefined) {
    const min = query.bedroomsMin;
    predicates.push({
      key: "bedroomsMin",
      label: `${min}+ bedrooms`,
      test: (l) => l.bedrooms >= min,
    });
  }

  if (query.bathroomsMin !== undefined) {
    const min = query.bathroomsMin;
    predicates.push({
      key: "bathroomsMin",
      label: `${min}+ bathrooms`,
      test: (l) => l.bathrooms >= min,
    });
  }

  if (query.sizeSqftMin !== undefined) {
    const min = query.sizeSqftMin;
    predicates.push({
      key: "sizeSqftMin",
      label: `${min}+ sqft`,
      // 面积缺失 ≠ 不满足。放行并在 caveats 里披露，由用户自己判断，
      // 总好过因为房东漏填一个字段就让用户错过一套合适的房子。
      test: (l) => l.sizeSqft === null || l.sizeSqft >= min,
    });
  }

  const hasPlace = query.areas?.length || query.districts?.length || query.stations?.length;
  if (hasPlace) {
    const areas = new Set(query.areas ?? []);
    const districts = new Set(query.districts ?? []);
    const stations = new Set(query.stations ?? []);
    const parts = [...areas, ...districts, ...stations];
    predicates.push({
      key: "place",
      label: `In ${parts.join(" / ")}`,
      test: (l) =>
        areas.has(l.area) ||
        (l.district !== null && districts.has(l.district)) ||
        (l.nearestMrt !== null && stations.has(l.nearestMrt.station)),
    });
  }

  if (query.maxWalkMinutes !== undefined) {
    const max = query.maxWalkMinutes;
    predicates.push({
      key: "maxWalkMinutes",
      label: `${max} min walk to MRT`,
      // 同面积：站点信息缺失不等于不满足
      test: (l) => l.nearestMrt === null || l.nearestMrt.walkMinutes <= max,
    });
  }

  if (query.furnishing?.length) {
    const wanted = new Set(query.furnishing);
    predicates.push({
      key: "furnishing",
      label: `${query.furnishing.join(" / ")} furnishing`,
      test: (l) => wanted.has(l.furnishing),
    });
  }

  if (query.requireCooking) {
    predicates.push({ key: "requireCooking", label: "Cooking allowed", test: (l) => l.cookingAllowed });
  }
  if (query.requirePet) {
    predicates.push({ key: "requirePet", label: "Pet-friendly", test: (l) => l.petFriendly });
  }
  if (query.requireAircon) {
    predicates.push({ key: "requireAircon", label: "Air-conditioned", test: (l) => l.aircon });
  }
  if (query.requireUtilitiesIncluded) {
    predicates.push({
      key: "requireUtilitiesIncluded",
      label: "Utilities included",
      test: (l) => l.utilitiesIncluded,
    });
  }

  if (query.maxLeaseMinMonths !== undefined) {
    const max = query.maxLeaseMinMonths;
    predicates.push({
      key: "maxLeaseMinMonths",
      label: `${max}-month lease or shorter`,
      test: (l) => l.leaseMinMonths <= max,
    });
  }

  if (query.moveInBy !== undefined && DATE_RE.test(query.moveInBy)) {
    const by = query.moveInBy;
    predicates.push({
      key: "moveInBy",
      label: `Available by ${by}`,
      // 日期都是 YYYY-MM-DD，字符串比较即可，不引入时区问题
      test: (l) => l.availableFrom <= by,
    });
  }

  if (query.occupantType !== undefined) {
    const wanted = query.occupantType;
    predicates.push({
      key: "occupantType",
      label: `Accepts ${wanted}`,
      test: (l) =>
        l.tenantPreferences.occupantType === "any" || l.tenantPreferences.occupantType === wanted,
    });
  }

  if (query.directOwnerOnly) {
    predicates.push({ key: "directOwnerOnly", label: "Direct owner, no agent fee", test: (l) => l.directOwner });
  }

  if (query.amenities?.length) {
    const wanted = query.amenities;
    predicates.push({
      key: "amenities",
      label: `Has ${wanted.join(" / ")}`,
      test: (l) => wanted.every((a) => l.amenities.includes(a)),
    });
  }

  if (query.tenantGender !== undefined) {
    const gender = query.tenantGender;
    predicates.push({
      key: "tenantGender",
      label: "Owner accepts your gender",
      // 保护性筛选：排除掉会拒绝这位租客的房源，避免白跑一趟
      test: (l) =>
        l.tenantPreferences.gender === null ||
        l.tenantPreferences.gender === "any" ||
        l.tenantPreferences.gender === gender,
    });
  }

  // 这里没有、也不会有 nationality 过滤器。
  // 排他性国籍偏好不是可检索维度 —— agent 不是"拒绝配合"，而是系统上就做不到。

  return predicates;
}

// ---------------------------------------------------------------------------
// 软打分
// ---------------------------------------------------------------------------

/** 把「越小越好」的值映射到 0-1，超过 worst 记 0 */
function decay(value: number, best: number, worst: number): number {
  if (worst <= best) return 1;
  if (value <= best) return 1;
  if (value >= worst) return 0;
  return 1 - (value - best) / (worst - best);
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

function scoreOne(
  listing: CleanListing,
  query: SearchQuery,
  weights: ScoreWeights,
  today: string,
): { score: number; breakdown: ScoreComponent[] } {
  const components: Array<{
    dimension: keyof ScoreWeights;
    raw: number | null;
    evidence: string;
  }> = [];

  // --- 预算贴合度：把预算用足，而不是越便宜越好 -----------------------------
  //
  // 曾经这里是"同类里越便宜分越高"，那是错的：预算是**天花板**不是**目标**。
  // 用户说 $1,800，排第一的却是 $650 —— 那恰恰是这个预算段里最差的房子。
  // 在天花板以内，人要的是"能拿到的最好的"。
  //
  // 用户没给预算时这一维**完全不参与**（raw = null，不进分母）：
  // 他没表达过对价格的偏好，我们就不该替他假设一个。贵不贵该由他自己提。
  if (query.budgetMax !== undefined && listing.monthlyRentSgd !== null) {
    const rent = listing.monthlyRentSgd;
    // 硬过滤已保证 rent ≤ budgetMax，所以比值落在 (0, 1]
    components.push({
      dimension: "budgetFit",
      raw: Math.min(1, rent / query.budgetMax),
      evidence: `$${rent.toLocaleString()}/mo against a $${query.budgetMax.toLocaleString()} budget`,
    });
  } else {
    components.push({
      dimension: "budgetFit",
      raw: null,
      evidence:
        listing.monthlyRentSgd === null
          ? "no rent data"
          : `$${listing.monthlyRentSgd.toLocaleString()}/mo (no budget given)`,
    });
  }

  // --- 通勤：只用房源自带的步行分钟。不用合成坐标算距离，那是精确的假数据 ---
  if (listing.nearestMrt !== null) {
    const walk = listing.nearestMrt.walkMinutes;
    components.push({
      dimension: "commute",
      raw: decay(walk, 3, 20),
      evidence: `${walk} min walk to ${listing.nearestMrt.station} (${listing.nearestMrt.line})`,
    });
  } else {
    components.push({ dimension: "commute", raw: null, evidence: "no nearest MRT listed" });
  }

  // --- 面积：用户给了下限才计分，超出越多越好，封顶在 1.5 倍 ----------------
  if (query.sizeSqftMin !== undefined && listing.sizeSqft !== null) {
    const ratio = listing.sizeSqft / query.sizeSqftMin;
    components.push({
      dimension: "size",
      raw: Math.max(0, Math.min(1, (ratio - 1) / 0.5)),
      evidence: `${listing.sizeSqft} sqft`,
    });
  } else {
    components.push({
      dimension: "size",
      raw: null,
      evidence: listing.sizeSqft === null ? "no size listed" : "no size requirement given",
    });
  }

  // --- 家具：拎包入住 > 部分配 > 空房。用户没指定时用这个通用序 -------------
  const furnishingRank: Record<Furnishing, number> = { fully: 1, partial: 0.5, unfurnished: 0 };
  components.push({
    dimension: "furnishing",
    raw: furnishingRank[listing.furnishing],
    evidence:
      listing.furnishing === "fully"
        ? "fully furnished"
        : listing.furnishing === "partial"
          ? "partially furnished"
          : "unfurnished",
  });

  // --- 设施：用户点名的设施命中比例 -----------------------------------------
  if (query.amenities?.length) {
    const hit = query.amenities.filter((a) => listing.amenities.includes(a));
    components.push({
      dimension: "amenities",
      raw: hit.length / query.amenities.length,
      evidence: hit.length > 0 ? `has ${hit.join(", ")}` : "none of the requested amenities listed",
    });
  } else {
    components.push({ dimension: "amenities", raw: null, evidence: "no amenity requirement given" });
  }

  // --- 新鲜度：挂得越久越可能已经租掉或有问题 -------------------------------
  const age = daysBetween(listing.postedDate, today);
  components.push({
    dimension: "freshness",
    raw: decay(age, 7, 90),
    evidence: `posted ${Math.round(age)} days ago`,
  });

  // --- 入住时间：越贴近用户希望的时间越好 -----------------------------------
  if (query.moveInBy !== undefined && DATE_RE.test(query.moveInBy)) {
    const gap = Math.abs(daysBetween(listing.availableFrom, query.moveInBy));
    components.push({
      dimension: "availability",
      raw: decay(gap, 0, 60),
      evidence: listing.isImmediate ? "available immediately" : `available from ${listing.availableFrom}`,
    });
  } else {
    components.push({
      dimension: "availability",
      raw: null,
      evidence: listing.isImmediate ? "available immediately" : `available from ${listing.availableFrom}`,
    });
  }

  // 不适用的维度（raw = null）不参与分母，避免"没数据"被当成"得分低"
  const breakdown: ScoreComponent[] = components.map((c) => ({
    dimension: c.dimension,
    raw: c.raw,
    weight: weights[c.dimension],
    weighted: c.raw === null ? 0 : c.raw * weights[c.dimension],
    evidence: c.evidence,
  }));

  const applicable = breakdown.filter((c) => c.raw !== null);
  const totalWeight = applicable.reduce((sum, c) => sum + c.weight, 0);
  const score = totalWeight === 0 ? 0 : applicable.reduce((sum, c) => sum + c.weighted, 0) / totalWeight;

  return { score, breakdown };
}

// ---------------------------------------------------------------------------
// 披露事项
// ---------------------------------------------------------------------------

/**
 * 必须让用户知道的事。
 *
 * 原则：不确定性要显式暴露，而不是抹平。缺面积就说缺面积，房东有国籍限制就提前
 * 告知 —— 后者是保护用户不白跑一趟，不是在执行歧视。
 */
function buildCaveats(listing: CleanListing, query: SearchQuery): string[] {
  const caveats: string[] = [];

  if (listing.sizeSqft === null) caveats.push("Size not listed");
  if (listing.nearestMrt === null) caveats.push("Nearest MRT not listed");
  if (listing.districtInferred) caveats.push("District inferred from nearby listings, not stated by the owner");
  if (listing.dataQuality.flags.includes("bedrooms_contradiction")) {
    caveats.push("Bedroom count conflicts with the rental type — rental type is authoritative");
  }

  const nationality = listing.tenantPreferences.nationality;
  if (nationality?.kind === "exclusive") {
    // 无论用户有没有告知自己的国籍都要提示 —— 这是房源的既有限制，与用户是谁无关
    caveats.push(`Owner states a nationality preference ("${nationality.raw}") — this may affect your application`);
  }

  if (
    query.tenantGender !== undefined &&
    listing.tenantPreferences.gender !== null &&
    listing.tenantPreferences.gender !== "any" &&
    listing.tenantPreferences.gender !== query.tenantGender
  ) {
    caveats.push(`Owner prefers ${listing.tenantPreferences.gender} tenants`);
  }

  if (listing.rentNegotiable) caveats.push("Rent marked negotiable");

  return caveats;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export type SearchOptions = {
  weights?: ScoreWeights;
  limit?: number;
  /** 参考日期，用于新鲜度计算。默认取清洗时的参考日 */
  today?: string;
};

export function searchListings(
  listings: CleanListing[],
  query: SearchQuery,
  options: SearchOptions = {},
): SearchResult {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const today = options.today ?? "2026-07-28";
  const limit = options.limit ?? 20;

  // 只从可推荐的房源里选。租金异常、重复行永远不会出现在用户面前。
  const pool = listings.filter((l) => l.dataQuality.isRecommendable);
  const predicates = buildPredicates(query);

  const excludedBy: Record<string, number> = {};
  for (const p of predicates) excludedBy[p.key] = 0;

  const survivors: CleanListing[] = [];
  for (const listing of pool) {
    let passed = true;
    for (const p of predicates) {
      if (!p.test(listing)) {
        // 每条约束独立计数（不是"第一个失败就停"）—— 这样才能回答
        // "到底是哪个条件卡住了大多数房源"
        excludedBy[p.key] += 1;
        passed = false;
      }
    }
    if (passed) survivors.push(listing);
  }

  const scored: ScoredListing[] = survivors.map((listing) => {
    const { score, breakdown } = scoreOne(listing, query, weights, today);
    return {
      listing,
      score,
      breakdown,
      matched: predicates.map((p) => p.label),
      caveats: buildCaveats(listing, query),
    };
  });

  // 分数相同时按 id 排序，保证结果完全确定 —— 同样的查询永远得到同样的顺序
  scored.sort((a, b) => b.score - a.score || a.listing.id.localeCompare(b.listing.id));

  return { hits: scored.slice(0, limit), total: scored.length, excludedBy, pool: pool.length };
}

// ---------------------------------------------------------------------------
// 放宽推演
// ---------------------------------------------------------------------------

/**
 * 一档放宽的默认幅度。
 *
 * 各约束必须放宽**同一量级的一档**，Δ 才有可比性。否则"直接删掉地点约束"
 * 永远 Δ 最大，但那不叫建议，那叫放弃需求。
 */
export type RelaxationNotch = {
  key: keyof SearchQuery;
  label: string;
  apply: (query: SearchQuery) => SearchQuery | null;
  describe: (query: SearchQuery) => string;
};

/**
 * 一档的步长。
 *
 * 单一真源：放宽推演（这里）和抽取层的相对调整（"再便宜点"）用的是同一组数字。
 * 分两处各定一套的话，用户会发现"我说再便宜点"和"系统建议放宽预算"幅度不一样。
 */
export const NOTCH_STEP = {
  /** 预算、面积按比例走 */
  budgetPct: 0.1,
  sizePct: 0.1,
  /** 步行时间按绝对分钟走 —— 按比例的话 3 分钟只放宽 18 秒，没意义 */
  walkMinutes: 5,
  /** 租期按倍数走 —— 6 个月的下一档是 12，不是 6.6 */
  leaseFactor: 2,
} as const;

export const DEFAULT_NOTCHES: RelaxationNotch[] = [
  {
    key: "budgetMax",
    label: "Budget",
    apply: (q) =>
      q.budgetMax === undefined
        ? null
        : { ...q, budgetMax: Math.round(q.budgetMax * (1 + NOTCH_STEP.budgetPct)) },
    describe: (q) =>
      `raise the budget to $${Math.round((q.budgetMax ?? 0) * (1 + NOTCH_STEP.budgetPct)).toLocaleString()} (+${NOTCH_STEP.budgetPct * 100}%)`,
  },
  {
    key: "sizeSqftMin",
    label: "Size",
    apply: (q) =>
      q.sizeSqftMin === undefined
        ? null
        : { ...q, sizeSqftMin: Math.round(q.sizeSqftMin * (1 - NOTCH_STEP.sizePct)) },
    describe: (q) =>
      `drop the size floor to ${Math.round((q.sizeSqftMin ?? 0) * (1 - NOTCH_STEP.sizePct))} sqft (−${NOTCH_STEP.sizePct * 100}%)`,
  },
  {
    key: "maxWalkMinutes",
    label: "Walk to MRT",
    apply: (q) =>
      q.maxWalkMinutes === undefined
        ? null
        : { ...q, maxWalkMinutes: q.maxWalkMinutes + NOTCH_STEP.walkMinutes },
    describe: (q) => `allow a ${(q.maxWalkMinutes ?? 0) + NOTCH_STEP.walkMinutes}-minute walk to the MRT`,
  },
  {
    key: "maxLeaseMinMonths",
    label: "Lease length",
    apply: (q) =>
      q.maxLeaseMinMonths === undefined
        ? null
        : { ...q, maxLeaseMinMonths: q.maxLeaseMinMonths * NOTCH_STEP.leaseFactor },
    describe: (q) =>
      `accept leases starting from ${(q.maxLeaseMinMonths ?? 0) * NOTCH_STEP.leaseFactor} months`,
  },
  {
    key: "furnishing",
    label: "Furnishing",
    apply: (q) => {
      if (!q.furnishing?.length || q.furnishing.includes("partial")) return null;
      return { ...q, furnishing: [...q.furnishing, "partial"] };
    },
    describe: () => "accept partially furnished places",
  },
  {
    key: "listingType",
    label: "Rental type",
    apply: (q) => (q.listingType === "whole_unit" ? { ...q, listingType: undefined } : null),
    describe: () => "consider rooms as well as whole units",
  },
  {
    key: "propertyTypes",
    label: "Property type",
    apply: (q) => (q.propertyTypes?.length ? { ...q, propertyTypes: undefined } : null),
    describe: () => "open up to any property type",
  },
];

export type Relaxation = {
  key: string;
  label: string;
  description: string;
  hitsBefore: number;
  hitsAfter: number;
  /** 放宽后多出来的房源数 */
  delta: number;
};

export type RelaxOptions = SearchOptions & {
  /**
   * 不许动的约束。用户明确说过"必须/一定要"的条件属于底线，
   * 即使这轮没被提及也不该被反复试探。
   */
  keep?: Array<keyof SearchQuery>;
  /**
   * 用户自己给出的放宽幅度，优先于档位表。
   * 用户说"我最多能到 $1,000"就按 $1,000 算，而不是按 +10% 算。
   */
  overrides?: Partial<SearchQuery>;
  /** 地点放宽的候选（由调用方在闭集内解析后传入，引擎本身不做地理推断） */
  areaExpansion?: string[];
  /** 只返回排序后的前 N 条。呈现时给多了会变成甩清单，但过滤仍是调用方的事 */
  top?: number;
};

/**
 * 算出「放宽哪一条能多出多少房源」。
 *
 * 刻意做成独立函数，而不是塞进 searchListings 里：
 * **什么时候把放宽建议讲给用户听，是产品决策，不是检索能力的一部分。**
 * 命中 0 条就立刻甩一张放宽清单，等于替用户做了他还没做的决定。
 */
export function computeRelaxations(
  listings: CleanListing[],
  query: SearchQuery,
  options: RelaxOptions = {},
): Relaxation[] {
  const keep = new Set(options.keep ?? []);
  const before = searchListings(listings, query, options).total;
  const results: Relaxation[] = [];

  // 优先级 ①：用户自己给出的幅度，直接用，不走档位表
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (keep.has(key as keyof SearchQuery)) continue;
    const relaxed = { ...query, [key]: value };
    const after = searchListings(listings, relaxed, options).total;
    results.push({
      key,
      label: key,
      description: `set ${key} to ${JSON.stringify(value)}, as you asked`,
      hitsBefore: before,
      hitsAfter: after,
      delta: after - before,
    });
  }

  const overridden = new Set(Object.keys(options.overrides ?? {}));

  // 优先级 ②：档位表的默认幅度
  for (const notch of DEFAULT_NOTCHES) {
    if (keep.has(notch.key) || overridden.has(notch.key)) continue;
    const relaxed = notch.apply(query);
    if (relaxed === null) continue; // 该约束没被使用，无从放宽
    const after = searchListings(listings, relaxed, options).total;
    results.push({
      key: notch.key,
      label: notch.label,
      description: notch.describe(query),
      hitsBefore: before,
      hitsAfter: after,
      delta: after - before,
    });
  }

  // 地点放宽需要外部提供候选 —— 引擎不做地理推断
  if (options.areaExpansion?.length && !keep.has("areas") && query.areas?.length) {
    const relaxed = { ...query, areas: [...new Set([...query.areas, ...options.areaExpansion])] };
    const after = searchListings(listings, relaxed, options).total;
    results.push({
      key: "areas",
      label: "Location",
      description: `also include ${options.areaExpansion.join(", ")}`,
      hitsBefore: before,
      hitsAfter: after,
      delta: after - before,
    });
  }

  // 返回全部推演结果，包括 delta = 0 的。
  //
  // 不在这里过滤掉无效放宽，是因为「所有单档放宽都无济于事」本身是关键信号 ——
  // 它意味着冲突是结构性的，而不是差一点点。如果引擎只吐正增量，调用方就无法
  // 区分「没有可放宽的约束」和「放宽了也没用」，而这两种情况该说的话完全不同。
  //
  // 呈现时该只讲有增量的那几条，但那是产品决策，由调用方 filter(r => r.delta > 0)。
  const sorted = results.sort((a, b) => b.delta - a.delta || a.key.localeCompare(b.key));

  return options.top === undefined ? sorted : sorted.slice(0, options.top);
}
