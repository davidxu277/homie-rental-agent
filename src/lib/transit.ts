/**
 * 真实公共交通行程时间 —— 唯一依赖外部数据源的模块。
 *
 * 为什么需要它：房源数据里 nearestMrt 只有 station / line / walkMinutes，
 * 没有任何站间行程时间。"通勤 40 分钟到 Raffles Place" 因此完全算不出来，
 * 早先系统把它硬塞进 maxWalkMinutes + stations，反而把一个几乎不排除任何
 * 东西的要求变成了整个查询里最紧的一条（21 套 → 0 套）。
 *
 * **边界要说清楚**：房源是作业提供的合成数据，一条都没换；这里取到的只是
 * 站点之间的真实行程时间。两者拼在一起算总通勤：
 *
 *     总时长 = listing.nearestMrt.walkMinutes   （来自房源数据）
 *            + transit(该站 → 目的地)            （来自 Google）
 *
 * 走到地铁站那一段仍然完全来自房源自己的字段。没有 nearestMrt 的房源
 * （500 套里有 6 套）改用它所在的区域当起点，精度差一档但算得出来。
 *
 * 为什么是 Distance Matrix 而不是逐条查路线：它一次请求能带 25 个起点，
 * 85 个站分 4 次就查完，并发下大约 1 秒 —— 所以不需要"先缩小候选再算通勤"
 * 那套顺序依赖，直接全量算，commute 就能当成普通硬约束用。
 */

/** 一次请求最多带几个起点（Google 的限制） */
const ORIGINS_PER_REQUEST = 25;

/** 外部依赖必须有超时 —— 挂了要退回"算不出来"，而不是让整轮对话卡死 */
const TIMEOUT_MS = 8_000;

/**
 * 查行程时间用的出发时刻：下一个工作日**新加坡时间**早上 9 点。
 *
 * 公交行程时间随时刻变化（末班车、班次密度），必须固定一个参考时刻，
 * 否则同一套房深夜查和早高峰查结果不同，推荐就不可复现了。
 * 选通勤高峰是因为用户问的就是上班通勤。
 *
 * **必须显式用新加坡时区**，不能用 setHours。踩过：开发机在 PDT，
 * "明天 9 点" 算出来是新加坡周日凌晨 0 点，Google 只能等首班车，
 * Pasir Ris → Raffles Place 查出 5 小时 10 分钟。部署到 Vercel（UTC）
 * 则会变成新加坡下午 5 点晚高峰 —— 两种都是错的，而且错得很隐蔽：
 * 返回的是合法数字，只是答的不是同一个问题。
 *
 * 新加坡是 UTC+8 且不实行夏令时，所以 09:00 SGT 恒等于 01:00 UTC 同一天，
 * 全程用 UTC 方法即可，不需要时区库。
 */
export function departureTime(now = new Date()): number {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(1, 0, 0, 0); // = 09:00 Asia/Singapore
  // 01:00 UTC 和 09:00 SGT 是同一个日历日，所以这里的星期几就是新加坡的星期几
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return Math.floor(d.getTime() / 1000);
}

/**
 * 一个起点。
 *
 * key 是调用方用来对回结果的标识；query 是真正拿去地理编码的字符串。
 * 两者分开，是因为起点**不一定是地铁站** —— 6 套房源没有 nearestMrt，
 * 只能拿它们所在的区域当位置。区域名不能加 "MRT Station" 后缀，
 * 否则 "Bukit Panjang, Singapore" 会被拧成一个未必存在的站。
 */
export type TransitOrigin = { key: string; query: string };

/** 站名 → 查询串。加上国家限定，避免撞上别国同名站 */
export function stationOrigin(station: string): TransitOrigin {
  return { key: station, query: `${station} MRT Station, Singapore` };
}

/** 区域名 → 查询串。精度不如站点（落在片区中心而不是门口），但远好过算不出来 */
export function areaOrigin(area: string): TransitOrigin {
  return { key: `area:${area}`, query: `${area}, Singapore` };
}

/**
 * 目的地**不查我们的闭集**。
 *
 * 用户要去的地方可以是任何地方 —— NUS、樟宜机场、某个商场 —— 这些都不在
 * 房源数据的词表里。拿闭集卡目的地会把 "how far is it from NUS?"（作业原文
 * 给的示例问题）直接丢掉。交给 Google 去解析，解析不出来就诚实说找不到。
 */
function destinationQuery(destination: string): string {
  return /singapore/i.test(destination) ? destination : `${destination}, Singapore`;
}

/**
 * 我们的出行方式 → Google 的 mode 参数。
 *
 * bus 和 mrt 都映射到 transit：Google 的 transit 模式本来就同时考虑地铁和巴士，
 * 它会给出综合最优方案。硬要只走巴士得用 transit_mode 参数，但用户说"坐巴士"
 * 通常只是在说"我不开车"，不是在指定必须全程巴士。
 */
const GOOGLE_MODE: Record<string, string> = {
  mrt: "transit",
  bus: "transit",
  walk: "walking",
  drive: "driving",
};

export type TransitLookup = {
  /** 起点 key → 到目的地的分钟数。查不到的起点不出现在这里 */
  minutes: Map<string, number>;
  /** 目的地是否解析成功。false 时 minutes 一定是空的 */
  resolved: boolean;
  /** 失败原因，进日志和降级提示 */
  error?: string;
};

export interface TransitProvider {
  lookup(origins: TransitOrigin[], destination: string, mode?: string): Promise<TransitLookup>;
}

// ---------------------------------------------------------------------------

type MatrixResponse = {
  status: string;
  error_message?: string;
  origin_addresses?: string[];
  destination_addresses?: string[];
  rows?: Array<{
    elements: Array<{
      status: string;
      duration?: { value: number };
      /** 仅驾车模式返回，考虑了实时路况 */
      duration_in_traffic?: { value: number };
    }>;
  }>;
};

/**
 * Google Distance Matrix 实现。
 *
 * 缓存键是 `站名|目的地|出行方式`，跨对话、跨用户共享 —— 三者都是稳定实体，
 * 行程时间在参考时刻固定的前提下也是稳定的。进程内缓存即可：
 * Vercel 冷启动会丢，但代价只是重新查一次，不影响正确性。
 *
 * **出行方式必须进缓存键**：同一个目的地开车 15 分钟、地铁 40 分钟，
 * 键里不带 mode 的话两者会互相覆盖，用户问开车却拿到地铁的数。
 */
export class GoogleTransitProvider implements TransitProvider {
  private cache = new Map<string, number>();
  /** 解析失败过的目的地不再重试 —— 拼错的地名重试多少次都一样 */
  private unresolvable = new Set<string>();

  // 显式字段而不是构造函数参数属性 —— 后者不是可擦除语法，
  // Node 直接跑 .ts 时编译不过（tsconfig 开了 erasableSyntaxOnly）
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async lookup(
    origins: TransitOrigin[],
    destination: string,
    mode?: string,
  ): Promise<TransitLookup> {
    // 用户没说怎么去就按公共交通算 —— 新加坡租房场景下这是默认假设
    const googleMode = GOOGLE_MODE[mode ?? "mrt"] ?? "transit";
    const minutes = new Map<string, number>();

    if (this.unresolvable.has(destination)) {
      return { minutes, resolved: false, error: "destination could not be resolved" };
    }

    const missing: TransitOrigin[] = [];
    for (const origin of origins) {
      const cached = this.cache.get(`${origin.query}|${destination}|${googleMode}`);
      if (cached === undefined) missing.push(origin);
      else minutes.set(origin.key, cached);
    }

    if (missing.length === 0) return { minutes, resolved: true };

    const batches: TransitOrigin[][] = [];
    for (let i = 0; i < missing.length; i += ORIGINS_PER_REQUEST) {
      batches.push(missing.slice(i, i + ORIGINS_PER_REQUEST));
    }

    const depart = departureTime();
    let anyResolved = false;
    let error: string | undefined;

    // 并发发出去 —— 4 个请求串行是 4 倍延迟，没有理由
    const results = await Promise.all(
      batches.map((batch) => this.fetchBatch(batch, destination, depart, googleMode)),
    );

    for (const [index, result] of results.entries()) {
      if ("error" in result) {
        error ??= result.error;
        continue;
      }
      anyResolved = true;
      for (const [offset, seconds] of result.durations.entries()) {
        if (seconds === null) continue;
        const origin = batches[index][offset];
        const value = Math.round(seconds / 60);
        this.cache.set(`${origin.query}|${destination}|${googleMode}`, value);
        minutes.set(origin.key, value);
      }
    }

    // 一个起点都没查到 ⇒ 目的地本身有问题，记下来别再浪费请求
    if (!anyResolved && minutes.size === 0) {
      this.unresolvable.add(destination);
      return { minutes, resolved: false, error: error ?? "no route data returned" };
    }

    return { minutes, resolved: true, ...(error ? { error } : {}) };
  }

  private async fetchBatch(
    origins: TransitOrigin[],
    destination: string,
    depart: number,
    mode: string,
  ): Promise<{ durations: Array<number | null> } | { error: string }> {
    const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
    url.searchParams.set("origins", origins.map((o) => o.query).join("|"));
    url.searchParams.set("destinations", destinationQuery(destination));
    url.searchParams.set("mode", mode);
    url.searchParams.set("key", this.apiKey);
    // departure_time 只对公交（班次）和驾车（路况）有意义；
    // 步行/骑行传了会被忽略，但传着也无害，统一带上省一个分支
    url.searchParams.set("departure_time", String(depart));

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) return { error: `distance matrix HTTP ${response.status}` };

      const body = (await response.json()) as MatrixResponse;
      if (body.status !== "OK") {
        // key 无效、超额、参数错 —— 都在这里现形。带上 error_message 便于排查
        return { error: `${body.status}${body.error_message ? `: ${body.error_message}` : ""}` };
      }

      return {
        durations: (body.rows ?? []).map((row) => {
          const element = row.elements?.[0];
          if (element?.status !== "OK") return null;
          // 驾车模式下 Google 会额外给出考虑实时路况的耗时 —— 那个才是用户
          // 真正会花的时间。新加坡高峰期两者能差出十几分钟
          return element.duration_in_traffic?.value ?? element.duration?.value ?? null;
        }),
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { error: `distance matrix request failed: ${message}` };
    }
  }
}

/** 没配 key 时用它 —— 行为完全等同于"这条约束算不出来"，和接入前一致 */
export class UnavailableTransitProvider implements TransitProvider {
  async lookup(): Promise<TransitLookup> {
    return { minutes: new Map(), resolved: false, error: "GOOGLE_MAPS_API_KEY is not set" };
  }
}

export function createTransitProvider(): TransitProvider {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  return key ? new GoogleTransitProvider(key) : new UnavailableTransitProvider();
}
