/**
 * 通勤过滤 —— 把外部行程时间接进检索结果的那一层。
 *
 * **刻意独立于 search.ts**：检索引擎是纯同步函数，整套测试都建立在这个性质上。
 * 通勤要发网络请求，塞进谓词里会让 searchListings 变成 async，所有调用点和
 * 测试都得跟着改，而且引擎从此不可能在没有网络的环境下跑。
 *
 * 所以分工是：
 *   search.ts   跑完所有内存过滤，产出候选集（纯的、可测的）
 *   这里        对候选集补一次外部查询，再过滤一遍（异步、可注入）
 *
 * 门到门的算法：
 *   总时长 = listing.nearestMrt.walkMinutes  （房源数据自己的字段）
 *          + transit(该站 → 目的地)           （外部）
 * 走到地铁站那段始终来自合成数据，只有列车段是真实世界的。
 */

import {
  computeRelaxations,
  decay,
  rankRelaxations,
  relaxationCandidates,
  searchListings,
  type Relaxation,
  type RelaxOptions,
  type ScoredListing,
  type SearchQuery,
  type SearchResult,
} from "./search.ts";
import type { CleanListing } from "./types.ts";
import { areaOrigin, stationOrigin, type TransitOrigin, type TransitProvider } from "./transit.ts";

/**
 * 用户说了目的地却没给容忍度时，默认用多少分钟卡。
 *
 * 这**不是**模型编出来的数字 —— 那种编造（"by DRIVE, under 20 min"）是从一句
 * 没有任何交通字眼的话里冒出来的，用户无从察觉。这里是一条固定的产品默认值：
 * 对每个用户都一样、写死在代码里、并且在侧栏和回复里都明说是默认值。
 *
 * 40 分钟是新加坡通勤的常识分界线：全岛地铁通达，超过 40 分钟基本就意味着
 * 跨半个岛。说了"我在 X 上班"的人，本意就是不想住到通勤离谱的地方；
 * 只排序不过滤会让 60 分钟的房源照样出现在结果里，用户还得自己一张张看。
 */
export const DEFAULT_MAX_COMMUTE_MINUTES = 40;

export type CommuteOutcome = {
  /** 这一轮到底有没有真的按通勤筛过 —— 决定 agent 怎么措辞、界面怎么标 */
  applied: boolean;
  /** 实际生效的分钟上限 */
  maxMinutes?: number;
  /** 上限是系统默认值而非用户说的 —— 必须告诉用户，否则又成了看不见的约束 */
  assumedMax?: boolean;
  /** 没筛成的原因，用户看得懂的一句话 */
  reason?: string;
  /** 门到门分钟数，按房源 id 索引。界面和模型都用它 */
  minutes: Map<string, number>;
  /** 因为缺站点数据而无法核算、但仍被放行的房源数 */
  unverified: number;
};

/**
 * 过网络的形状。
 *
 * CommuteOutcome.minutes 是 Map，而 `JSON.stringify(new Map())` 是 `{}` ——
 * 不会报错，只是数据静悄悄地没了。踩过：线上通勤筛选正常、模型也拿到了
 * 分钟数，但前端卡片上的时间死活不显示。凡是要过 JSON 的地方都得摊平。
 */
export type CommuteSummary = {
  applied: boolean;
  maxMinutes?: number;
  assumedMax?: boolean;
  reason?: string;
  unverified: number;
  minutes: Record<string, number>;
};

export function toSummary(outcome: CommuteOutcome): CommuteSummary {
  return {
    applied: outcome.applied,
    ...(outcome.maxMinutes !== undefined ? { maxMinutes: outcome.maxMinutes } : {}),
    ...(outcome.assumedMax ? { assumedMax: true } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    unverified: outcome.unverified,
    minutes: Object.fromEntries(outcome.minutes),
  };
}

export const NO_COMMUTE: CommuteOutcome = {
  applied: false,
  minutes: new Map(),
  unverified: 0,
};

export type CommuteNeedInput = {
  destination: string;
  /** mrt / bus / walk / drive —— 决定按哪种方式算耗时，缺省按公共交通 */
  mode?: string;
  maxMinutes?: number;
};

/**
 * 一套房源在地图上的位置代理。
 *
 * 数据里没有门牌号和经纬度，只能拿别的字段近似：
 *   ① nearestMrt.station —— 最准的一档，另外还带了走到站要几分钟
 *   ② area              —— 500 套里有 6 套没有 nearestMrt
 *   ③ 都没有            —— 才真的算不出来
 *
 * 加这条兜底的原因很实在：SG0154（Bukit Panjang）没有最近地铁站，于是
 * "步行 20 分钟到 NUS" 这个查询算不出它的时间，按「缺失 ≠ 不满足」放行，
 * 结果它成了唯一一套结果、还排在第 1。可它在数据里明明写着 Bukit Panjang，
 * 走去 NUS 要三个多小时。**放行是为了不误伤，不是为了顶替真答案** ——
 * 只要还有一个能定位的字段，就该去查，而不是直接归入"查不到"。
 */
function originOf(listing: CleanListing): TransitOrigin | null {
  if (listing.nearestMrt) return stationOrigin(listing.nearestMrt.station);
  if (listing.area) return areaOrigin(listing.area);
  return null;
}

/** 用户给了上限就用用户的，没给就用默认的 40 分钟 */
export function effectiveMax(need: CommuteNeedInput): { minutes: number; assumed: boolean } {
  return need.maxMinutes === undefined
    ? { minutes: DEFAULT_MAX_COMMUTE_MINUTES, assumed: true }
    : { minutes: need.maxMinutes, assumed: false };
}

/**
 * 对候选集应用通勤约束。
 *
 * **只要用户说了目的地就一定会算、也一定会筛**。早先的做法是没给分钟数就
 * 只算不筛，界面上挂一个 "not filtered" 的橙标 —— 用户说 "we both work in
 * Jurong East" 之后拿到一堆通勤一小时的房子，还得自己一张张核对。
 * 说了在哪上班本来就是在表达通勤诉求，默认值见 DEFAULT_MAX_COMMUTE_MINUTES。
 *
 * 三种放行情形，全部遵循这个项目一贯的「缺失 ≠ 不满足」原则 ——
 * 房东漏填一个字段不该让用户错过一套合适的房子，缺的东西在 caveat 里披露：
 *   ① 房源没有最近地铁站
 *   ② 外部服务查不到该站到目的地的路线
 *   ③ 目的地整体解析失败 / 服务不可用 → 整条约束降级，一套都不筛
 */
export async function applyCommuteFilter(
  base: SearchResult,
  need: CommuteNeedInput | undefined,
  provider: TransitProvider,
): Promise<{ hits: ScoredListing[]; total: number; commute: CommuteOutcome }> {
  const passthrough = { hits: base.hits, total: base.total, commute: NO_COMMUTE };

  if (!need) return passthrough;
  const max = effectiveMax(need);

  const origins = new Map<string, TransitOrigin>();
  for (const hit of base.hits) {
    const origin = originOf(hit.listing);
    if (origin) origins.set(origin.key, origin);
  }
  // 一套都定位不了 —— 没必要发请求，但也不能装作筛过了
  if (origins.size === 0) {
    return {
      hits: base.hits,
      total: base.total,
      commute: {
        applied: false,
        maxMinutes: max.minutes,
        assumedMax: max.assumed,
        ...(base.hits.length > 0 ? { reason: "these listings have no location to route from" } : {}),
        minutes: new Map(),
        unverified: base.hits.length,
      },
    };
  }

  const lookup = await provider.lookup([...origins.values()], need.destination, need.mode);

  if (!lookup.resolved) {
    // 外部服务不可用或目的地解析不出来 —— 退回接入前的行为：不筛，并明说。
    // 这比"筛出 0 套"好得多：用户会以为是自己条件太苛刻。
    return {
      hits: base.hits,
      total: base.total,
      commute: {
        applied: false,
        maxMinutes: max.minutes,
        assumedMax: max.assumed,
        reason: lookup.error,
        minutes: new Map(),
        unverified: 0,
      },
    };
  }

  const minutes = new Map<string, number>();
  let unverified = 0;
  const kept: ScoredListing[] = [];

  for (const hit of base.hits) {
    const origin = originOf(hit.listing);
    const ride = origin ? lookup.minutes.get(origin.key) : undefined;

    if (origin === null || ride === undefined) {
      unverified += 1;
      kept.push(hit);
      continue;
    }

    // 步行到站那一段**只对公共交通成立**，而且只在起点真的是地铁站时成立 ——
    // 开车的人不会先走 5 分钟到地铁站再上车；起点是区域中心时也没有"走到站"
    // 这一段可言。数据里没有门牌号，站点/区域是我们对"房子在哪"仅有的近似。
    const mrt = hit.listing.nearestMrt;
    const usesStation = need.mode === undefined || need.mode === "mrt" || need.mode === "bus";
    const doorToDoor = mrt && usesStation ? mrt.walkMinutes + ride : ride;
    minutes.set(hit.listing.id, doorToDoor);

    if (doorToDoor <= max.minutes) {
      // 用真实门到门时间替换掉"走到最近地铁站几分钟"这个代理指标
      kept.push(rescore(hit, doorToDoor, need.destination, mrt === null));
    }
  }

  // 重打分改变了名次，得重排 —— 否则卡片顺序还是按旧分数来的
  kept.sort((a, b) => b.score - a.score || a.listing.id.localeCompare(b.listing.id));

  return {
    hits: kept,
    total: kept.length,
    commute: {
      applied: true,
      maxMinutes: max.minutes,
      assumedMax: max.assumed,
      minutes,
      unverified,
    },
  };
}

/**
 * 算上通勤的放宽推演。
 *
 * 为什么必须单独做一版：`computeRelaxations` 是纯内存的，它不知道通勤会
 * 再筛掉一部分。实测的偏差不小 —— 预算 $900 + 通勤≤40 分钟当前 9 套，
 * 纯内存版说"松到 $990 能多出 5 套"，把通勤算进去实际只多 2 套。
 *
 * 这个数字是用户做决定的依据（"多 5 套值得我多花 $90 吗"），虚报就是误导。
 *
 * 候选方案仍然由 relaxationCandidates 生成、排序仍然由 rankRelaxations 决定 ——
 * 两个版本共用同一套规则，只有"数有多少套"这一步不同，规则不会漂移。
 *
 * 成本：每个候选一次 applyCommuteFilter。目的地不变时缓存已经是热的，
 * 只有放宽后新引入的站才需要真正发请求，通常是个位数。
 */
export async function computeRelaxationsWithCommute(
  listings: CleanListing[],
  query: SearchQuery,
  provider: TransitProvider,
  options: RelaxOptions = {},
): Promise<Relaxation[]> {
  const need = query.commute;
  // 没有通勤约束时没有任何区别，走纯内存版，省掉一圈 await
  if (!need) return computeRelaxations(listings, query, options);

  // 通勤条件取自各候选自己的 query —— 放宽通勤那一条要用放宽后的阈值来数
  const count = async (q: SearchQuery): Promise<number> => {
    const base = searchListings(listings, q, { ...options, limit: 10_000 });
    const refined = await applyCommuteFilter(base, q.commute, provider);
    return refined.total;
  };

  const candidates = relaxationCandidates(query, options);

  // 通勤本身也是可以放宽的一条，但它不是内存谓词，引擎生成不了这个候选。
  // 卡在 40 分钟出不来结果时，"放到 55 分钟能多 12 套"往往比让用户加预算有用得多
  if (!options.keep?.includes("commute")) {
    const max = effectiveMax(need);
    const relaxed = max.minutes + COMMUTE_RELAX_STEP_MINUTES;
    candidates.push({
      key: "commute",
      label: "Commute",
      description: `allow up to ${relaxed} min to ${need.destination}`,
      query: { ...query, commute: { ...need, maxMinutes: relaxed } },
    });
  }
  const [before, ...after] = await Promise.all([
    count(query),
    ...candidates.map((candidate) => count(candidate.query)),
  ]);

  return rankRelaxations(candidates, before, after, options);
}

/**
 * 拿到真实通勤时间后重新打分。
 *
 * 检索层的 commute 维度只看「走到最近地铁站几分钟」—— 在没有目的地时这是
 * 唯一能用的信号，但用户一旦说了"我要去 Bukit Timah"，门到门时间显然更贴切：
 * 走 2 分钟到地铁站却要坐 50 分钟，和走 8 分钟坐 15 分钟，前者根本不算方便。
 *
 * 这一步也是「离 X 近」这种**软偏好**的落点。用户说"住附近就好"却没给时长，
 * 不该被翻译成硬过滤（早先写进 areas，把 34 分钟车程的房源直接扔掉了），
 * 而该让近的排前面、远的仍然看得见 —— 排序是表达偏好的正确方式。
 */
/** 放宽通勤的档位。15 分钟是"值得考虑一下"的量级，5 分钟太小、30 分钟等于换个活法 */
const COMMUTE_RELAX_STEP_MINUTES = 15;

const COMMUTE_BEST_MINUTES = 15;
const COMMUTE_WORST_MINUTES = 75;

function rescore(
  hit: ScoredListing,
  doorToDoor: number,
  destination: string,
  approximate = false,
): ScoredListing {
  const breakdown = hit.breakdown.map((component) =>
    component.dimension === "commute"
      ? {
          ...component,
          raw: decay(doorToDoor, COMMUTE_BEST_MINUTES, COMMUTE_WORST_MINUTES),
          weighted:
            decay(doorToDoor, COMMUTE_BEST_MINUTES, COMMUTE_WORST_MINUTES) * component.weight,
          // 起点是区域中心而不是具体站点时说清楚，别把近似值说成精确值
          evidence: approximate
            ? `about ${doorToDoor} min to ${destination} (from ${hit.listing.area}, no station listed)`
            : `${doorToDoor} min door-to-door to ${destination}`,
        }
      : component,
  );

  // 和 scoreOne 里一致：不适用的维度（raw = null）不进分母，
  // 免得"没数据"被当成"得分低"
  const applicable = breakdown.filter((c) => c.raw !== null);
  const totalWeight = applicable.reduce((sum, c) => sum + c.weight, 0);
  const score =
    totalWeight === 0 ? 0 : applicable.reduce((sum, c) => sum + c.weighted, 0) / totalWeight;

  return { ...hit, score, breakdown };
}
