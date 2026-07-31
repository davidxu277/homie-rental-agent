/**
 * 房源数据的类型契约。
 *
 * 这份文件同时被清洗脚本（scripts/clean.ts）和后面的检索层使用 —— 字段改名会在
 * 编译期报错，而不是等到运行时推荐结果变空才发现。
 */

export type PropertyType = "HDB" | "Condominium" | "Landed" | "Serviced Apartment";
export type ListingType = "whole_unit" | "room";
export type RoomType = "master_room" | "common_room";
export type Furnishing = "fully" | "partial" | "unfurnished";
export type AgentFee = "none" | "half_month" | "one_month";

export type Mrt = {
  station: string;
  line: string;
  walkMinutes: number;
};

export type Coordinates = {
  lat: number;
  lng: number;
};

// ---------------------------------------------------------------------------
// 输入：故意写得很宽松，因为 listings.json 就是脏的
// ---------------------------------------------------------------------------

export type RawListing = {
  id: string;
  title: string;
  propertyType: PropertyType;
  listingType: ListingType;
  roomType: RoomType | null;
  hdbFlatType: string | null;
  bedrooms: number;
  bathrooms: number;
  sizeSqft: number | null;
  district: string | null;
  area: string;
  address: string;
  nearestMrt: Mrt | null;
  /** 通常是 number，有时是 "S$1200" / "4400/mo" / "$5550 negotiable" 这类脏字符串 */
  monthlyRentSgd: number | string;
  /** 通常是 { months: 1 }，有时是 "1 month" */
  deposit: { months: number } | string;
  leaseMinMonths: number;
  /** "YYYY-MM-DD"，或者 "Immediate" / "ASAP" 这类自由文本 */
  availableFrom: string;
  furnishing: Furnishing;
  utilitiesIncluded: boolean;
  cookingAllowed: boolean;
  aircon: boolean;
  amenities: string[];
  petFriendly: boolean;
  tenantPreferences: {
    occupantType: string;
    maxOccupants: number;
    gender: string | null;
    nationality: string | null;
  };
  directOwner: boolean;
  agentFee: AgentFee;
  imageCount: number;
  coordinates: Coordinates;
  postedDate: string;
  description: string;
};

// ---------------------------------------------------------------------------
// 数据质量
// ---------------------------------------------------------------------------

/**
 * block —— 移出推荐池，用户永远看不到，进人工队列
 * warn  —— 照常推荐，但 agent 回答时必须披露
 * info  —— 自动规范化，不影响任何人，仅留审计痕迹
 */
export type Severity = "block" | "warn" | "info";

/**
 * 谁该去处理这条 issue —— 和 severity 正交。
 *
 * severity 说的是「产品怎么表现」，escalation 说的是「要不要人来管、管的人是谁」。
 * 两者不能合并：缺面积在产品上只需 warn（照常推荐 + 披露），但运维上确实该有人
 * 去问房东补；而租金写成 "S$1200" 是 info，也确实不需要任何人管。
 *
 * none            自动处理完毕，无需任何人介入
 * ops_review      我们自己能判断和修 —— 有 suggestedFix 待审核，或是 feed 的结构性缺陷
 * source_followup 信息在源头就缺失，只能回去问房东 / 中介，我们修不了
 */
export type Escalation = "none" | "ops_review" | "source_followup";

export type DataIssue = {
  /** hash(listingId + rule + field) —— 稳定，跨次运行可 diff，用于回归检测 */
  issueId: string;
  listingId: string;
  rule: string;
  field: string;
  severity: Severity;
  /** 由 rule 决定，见 Escalation 的说明 */
  escalation: Escalation;
  /** 原始值，永远保留 */
  raw: unknown;
  /** 清洗后的值（只有能自动规范化的才有） */
  normalized?: unknown;
  /**
   * 修复建议 —— 只进报告，不写回业务字段。
   * 租金错误在租房产品里伤害极大，系统提出建议、改不改由人决定。
   */
  suggestedFix?: {
    proposed: unknown;
    rule: string;
    confidence: number;
  };
  /** 判定依据，让人能复核 */
  evidence?: string;
  detectedAt: string;
};

/**
 * 国籍偏好的分类。
 *
 * exclusive（"No PRC" / "Local/PR only" / "Chinese"）不作为可检索、可排序的维度 ——
 * 检索层根本没有这个 filter 可以调用，agent 不是"拒绝配合"而是做不到。
 * 但保留展示：房源带国籍限制而用户不符合时要主动提示，避免用户白跑一趟。
 */
export type NationalityPreference = {
  raw: string;
  kind: "exclusive" | "inclusive";
};

export type DataQuality = {
  flags: string[];
  /** 该房源身上最严重的一档；没有任何 issue 时是 "ok" */
  severity: Severity | "ok";
  /** 有 block 级问题就是 false —— 检索层只从 true 的里面选 */
  isRecommendable: boolean;
};

// ---------------------------------------------------------------------------
// 输出：类型收紧，脏值已经不可能出现
// ---------------------------------------------------------------------------

export type CleanListing = {
  id: string;
  title: string;
  propertyType: PropertyType;
  listingType: ListingType;
  roomType: RoomType | null;
  hdbFlatType: string | null;
  bedrooms: number;
  bathrooms: number;
  /** null = 房源未提供。不猜，用户要求面积时该房源不参与筛选 */
  sizeSqft: number | null;
  district: string | null;
  /** true = district 是由 area 共现关系回填的，不是房源自带 */
  districtInferred: boolean;
  area: string;
  address: string;
  /** null = 未提供。不用合成坐标去反推，见 README 的取舍说明 */
  nearestMrt: Mrt | null;

  /** null = 解析失败或值不可信（此时必定伴随 block 级 issue） */
  monthlyRentSgd: number | null;
  /** 从 "$5550 negotiable" 这类写法里捞出来的业务信号，不是噪声 */
  rentNegotiable: boolean;
  /** 在 (listingType, propertyType) 同类里的价格分位，0=最便宜 */
  rentPercentileInCohort: number | null;

  deposit: { months: number } | null;
  leaseMinMonths: number;
  /** 一律规范成 YYYY-MM-DD；"Immediate" 类文本落到参考日期 */
  availableFrom: string;
  isImmediate: boolean;

  furnishing: Furnishing;
  utilitiesIncluded: boolean;
  cookingAllowed: boolean;
  aircon: boolean;
  amenities: string[];
  petFriendly: boolean;

  tenantPreferences: {
    occupantType: string;
    maxOccupants: number;
    gender: string | null;
    nationality: NationalityPreference | null;
  };

  directOwner: boolean;
  agentFee: AgentFee;
  imageCount: number;
  coordinates: Coordinates;
  postedDate: string;
  description: string;

  dataQuality: DataQuality;
};

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

export type Cohort = {
  listingType: ListingType;
  propertyType: PropertyType;
  n: number;
  median: number;
  p10: number;
  p90: number;
};

export type QualityReport = {
  generatedAt: string;
  referenceDate: string;
  input: { rows: number };
  output: { rows: number; recommendable: number; excluded: number };
  duplicates: {
    exactContent: Array<{ id: string; keptIndex: number; droppedIndex: number }>;
  };
  bySeverity: Record<string, number>;
  byEscalation: Record<string, number>;
  byRule: Record<string, number>;
  cohorts: Cohort[];
  areaCanonicalization: Array<{
    key: string;
    canonical: string;
    variants: Record<string, number>;
  }>;
};
