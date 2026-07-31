/**
 * 一轮对话的编排。
 *
 *   用户说话 → 抽取 → 归并状态 → 检索 → **代码决定分支** → 生成回复
 *
 * 分支判断刻意留在代码里，不交给模型：什么时候该共情、什么时候该给放宽建议、
 * 什么时候该闭嘴给结果 —— 这些是产品决策，必须是确定的、可测的、不会因为
 * 模型今天心情不同而变化的。模型只负责把定好的分支讲成人话。
 */

import type Anthropic from "@anthropic-ai/sdk";

import {
  extractRequirements,
  generateReply,
  type ReplySituation,
} from "./claude.ts";
import {
  applyCommuteFilter,
  computeRelaxationsWithCommute,
  toSummary,
  type CommuteSummary,
} from "./commute.ts";
import { buildConflictInsight, type ConflictInsight } from "./insight.ts";
import type { TransitProvider } from "./transit.ts";
import { searchListings, type Relaxation, type ScoredListing } from "./search.ts";
import {
  applyPatch,
  clarifyingQuestion,
  emptyState,
  needsClarification,
  pinnedSlots,
  toSearchQuery,
  type RequirementState,
  type SlotKey,
  type StateChange,
} from "./state.ts";
import type { CleanListing } from "./types.ts";
import type { Vocab } from "./vocab.ts";

export type Conversation = {
  state: RequirementState;
  /** 上一轮走的哪个分支 —— 决定这一轮 0 命中时是"共情"还是"给放宽建议" */
  lastSituation: ReplySituation | null;
  /** 上一轮 agent 说的话 —— 用户这一轮很可能是在回答它，抽取时必须一起看 */
  lastReply?: string;
  /** 上一轮有没有展示房源卡片 —— 用来判断这一轮要不要重复贴 */
  lastShowedCards?: boolean;
  /**
   * 最近几轮对话原文。
   *
   * **少了它，指代就解析不了**：用户说 "that price"、"this place"、"能议价吗"，
   * 指的是上文正在聊的那一套 —— 模型手上只有一个 5 元素的数组，
   * 没有上文就只能反问"你指哪一套？"。这不是模型不懂，是没给它看。
   */
  transcript?: Array<{ role: "user" | "agent"; text: string }>;
  /** 用户屏幕上当前能看到的房源 id —— 指代的候选范围 */
  shownIds?: string[];
  /** 连续追问了几轮 —— 超过上限就闭嘴给结果，防止死循环 */
  consecutiveClarify: number;
};

export function newConversation(): Conversation {
  return { state: emptyState(), lastSituation: null, consecutiveClarify: 0 };
}

/**
 * 最多连续问几轮。
 *
 * 这是**确定性的兜底**，不依赖模型判断：无论因为什么原因（答案没接住、
 * 模型反复标 ambiguous、用户答非所问），连问这么多次之后一律给结果。
 * 用户宁可看到不够精准的房源，也不想被盘问第四遍。
 */
const MAX_CONSECUTIVE_CLARIFY = 2;

/**
 * 命中数少到这个程度，就主动问一句要不要放宽。
 *
 * 用户看到 1 套会觉得"就这？"，而系统其实知道松一档能多出多少 ——
 * 有这个信息却不说，等于让用户自己去猜还有没有别的可能。
 */
const FEW_RESULTS = 5;

/** 带进上下文的对话轮数（user + agent 各算一条）。够解析指代，又不至于把 token 撑爆 */
const TRANSCRIPT_TURNS = 6;

/** 单条回复带进上下文时截断到多长 —— 只需要够认出在聊哪套房 */
const TRANSCRIPT_CHARS = 600;

export type TurnResult = {
  conversation: Conversation;
  situation: ReplySituation;
  reply: string;
  /** 状态变更清单，用于在界面上复述"我把区域改成了 X" */
  changes: StateChange[];
  /** 被校验层丢弃的抽取结果，进日志 */
  dropped: Array<{ slot: string; value: unknown; reason: string }>;
  hits: ScoredListing[];
  total: number;
  /** 这一轮通勤有没有真的参与筛选，以及各房源的门到门分钟数（已摊平，可过 JSON） */
  commute: CommuteSummary;
  relaxations: Relaxation[];
  usage: { input: number; output: number };
};

export type TurnOptions = {
  client: Anthropic;
  conversation: Conversation;
  userText: string;
  listings: CleanListing[];
  vocab: Vocab;
  /** 行程时间来源。注入而不是内部 new，是为了测试能塞一个不联网的桩 */
  transit: TransitProvider;
  /** 一次最多展示几套 */
  limit?: number;
};

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const { client, conversation, userText, listings, vocab } = options;
  const limit = options.limit ?? 5;

  // --- ① 抽取 + 归并 -------------------------------------------------------
  const extraction = await extractRequirements({
    client,
    state: conversation.state,
    userText,
    vocab,
    lastAgentMessage: conversation.lastReply,
  });
  const { state, changes } = applyPatch(conversation.state, extraction.patch);

  // 用户这一轮提到的槽位 = 他在坚持的条件，放宽推演不该碰
  const mentionedThisTurn = Object.keys(extraction.patch) as SlotKey[];

  // --- ② 检索 --------------------------------------------------------------
  //
  // 分两段：内存过滤（纯函数、可测）跑完之后，才对候选集补一次外部行程时间查询。
  // 通勤不能做成谓词 —— 那会让 searchListings 变成 async，整套纯函数测试全得改。
  const query = toSearchQuery(state);
  const base = searchListings(listings, query, { limit: 10_000 });
  const refined = await applyCommuteFilter(base, query.commute, options.transit);
  const result = {
    ...base,
    hits: refined.hits.slice(0, limit),
    total: refined.total,
  };
  const commute = refined.commute;

  // --- ③ 分支（产品决策，确定性的） ----------------------------------------
  let situation: ReplySituation;
  let relaxations: Relaxation[] = [];
  let question: string | undefined;
  let conflictInsight: ConflictInsight | undefined;

  // 用户说"别问了"，或者已经连问到上限 —— 无论如何这一轮都要出结果。
  // 少问一句的代价是结果不够精准；多问一句的代价是用户走人。
  const mustAnswerNow =
    extraction.wantsResultsNow || conversation.consecutiveClarify >= MAX_CONSECUTIVE_CLARIFY;

  // 用户只是在追问已经展示过的房源（"top pick 详细说说""能议价吗"）。
  // 状态没变 ⇒ 检索结果和上一轮**逐条相同**。
  //
  // 这个判断得在分支之前算：否则"上一轮是 sparse"会被当成"用户愿意谈放宽"，
  // 于是他问一句 top pick，回复末尾却挂着"要不要我说说放宽哪条能多出选择？" —— 答非所问。
  const askingAboutShownListings =
    Object.keys(extraction.patch).length === 0 && conversation.lastShowedCards === true;

  if (extraction.ambiguous.length > 0 && !mustAnswerNow) {
    // 模型自己举手说"这句话我拿不准"。这最优先 —— 它是对**用户刚说的话**的疑问，
    // 比任何基于状态缺口的追问都更贴题。
    //
    // 起因是实测里 "i work in the city" 被直接锁成了 areas:["City Hall"]：
    // city 可能是 Raffles Place / Tanjong Pagar / Marina Bay，模型挑一个填进去，
    // 用户根本不知道系统替他做了这个决定，然后一直被这个条件卡着。
    situation = "clarify";
    question = extraction.ambiguous[0].question;
  } else if (needsClarification(state) && !mustAnswerNow) {
    // 有效约束不足 2 条，检索没有意义 —— 问一句，且只问一句
    const ask = clarifyingQuestion(listings, state);
    situation = ask ? "clarify" : "results";
    question = ask?.question;
  } else if (askingAboutShownListings && !extraction.wantsRelaxAdvice && result.total > 0) {
    // 追问已展示的房源 —— 直接答他问的，不要再走"要不要放宽"那套。
    // 邀请上一轮已经发出去了，每轮都重复一遍就是催促。
    situation = "results";
  } else if (
    result.total === 0 ||
    result.total <= FEW_RESULTS ||
    extraction.wantsRelaxAdvice
  ) {
    // 已经告诉过用户"没有/很少"，他这一轮的回应就当作愿意谈放宽了。
    // 第一次不给清单，只邀请 —— 一上来就甩清单，等于替他做了还没做的决定。
    //
    // 但**他直接开口问**（"哪条最难满足？""我该让步什么？"）是另一回事：
    // 那是在要这个分析，还按"要不要放宽点条件"的套路走就是答非所问。
    // 而且答案本来就是现成的 —— 增量最大的那条就是最卡的那条。
    const wasToldScarce =
      extraction.wantsRelaxAdvice ||
      conversation.lastSituation === "empty" ||
      conversation.lastSituation === "sparse" ||
      conversation.lastSituation === "relax";

    if (wasToldScarce) {
      // 用带通勤的版本：纯内存版会把"放宽后多出几套"算得偏乐观，
      // 因为它不知道多出来的房源还得再过一遍通勤。这个数字是用户
      // 做决定的依据（"多 5 套值得我多花 $90 吗"），不能虚报。
      const all = await computeRelaxationsWithCommute(listings, query, options.transit, {
        // 用户说过"必须"的、以及这一轮刚重申的，都不进候选池
        keep: [...new Set([...pinnedSlots(state), ...mentionedThisTurn])],
      });
      const gains = all.filter((r) => r.delta > 0);

      if (gains.length > 0) {
        // 松一档就有结果 —— 给增量最大的两条，多了就变成甩清单
        situation = "relax";
        relaxations = gains.slice(0, 2);
      } else if (result.total > 0) {
        // 放宽也没用，但手上还有几套 —— 别把用户晾着，正常展示
        situation = "sparse";
      } else {
        // 有候选但全是 0，或压根没有可放宽的约束 —— 两种都是**结构性冲突**：
        // 不是差一点点，是这几条要求放在一起本身就不存在。
        //
        // 检索层为这个情况专门保留了全 0 的推演结果（见 computeRelaxations 的注释），
        // 早先我在这里一个 filter(delta > 0) 把信号滤掉了，agent 只能说
        // "没有可以放宽的选项" —— 对用户毫无价值。
        situation = "conflict";
        // 给模型的是"只保留某一条约束时库里实际什么情况"，不是"排除了多少套"。
        // 前者用户听得懂也用得上（"那我要多少预算才够"），后者是检索过程。
        conflictInsight = buildConflictInsight(listings, toSearchQuery(state));
      }
    } else {
      // 第一次遇到"少"或"没有"：只共情 + 邀请，不给清单
      situation = result.total === 0 ? "empty" : "sparse";
    }
  } else {
    situation = "results";
  }

  // 有房源就展示 —— sparse 和"放宽但原来那几套还在"的情况都该看到卡片，
  // 光说"符合的不多"却不给看，等于把用户晾着。
  //
  // 但两种情况不贴：
  //
  // ① clarify —— 既然在说"我还不确定你要什么"，就不该同时甩一个结果出来，
  //    用户会困惑到底该回答问题还是看房子。
  //
  // ② 用户只是在追问已经展示过的房源（见上面 askingAboutShownListings）——
  //    检索结果和上一轮逐条相同，整批再贴一遍纯属刷屏。
  //    但**回复里点到名的那几套仍然要贴**（见下面 mentionedIn），
  //    否则用户得往上翻才能看到你在说哪套。
  const showCards =
    result.total > 0 && situation !== "clarify" && !askingAboutShownListings;

  // --- ④ 生成回复 ----------------------------------------------------------
  const reply = await generateReply({
    client,
    situation,
    state,
    userText,
    // 模型始终拿到房源数据（追问时也要能答"top pick 好在哪"），
    // 但要知道界面上这次贴没贴卡片 —— 决定它是简写还是得把细节说出来
    hits: situation === "clarify" ? [] : result.hits,
    cardsShown: showCards,
    mentionedCardsShown: askingAboutShownListings,
    // 指代解析要靠这两样：上文说过什么，以及屏幕上现在有哪几套
    transcript: conversation.transcript ?? [],
    shownIds: conversation.shownIds ?? [],
    total: result.total,
    pool: result.pool,
    relaxations: situation === "relax" ? relaxations : undefined,
    conflictInsight,
    question,
    locationNote: extraction.locationNote,
    commute,
  });

  // --- ⑤ 决定贴哪些卡片 ----------------------------------------------------
  //
  // 新结果贴前几套；追问时只贴**回复里点到名的**那几套 —— 用户不用往上翻。
  // 用正则从回复里抓 id，是因为这样不需要模型额外表态：它提到谁，谁就出现。
  const mentioned = new Set(reply.text.match(/SG\d{4}/g) ?? []);
  const cards = showCards
    ? result.hits
    : result.hits.filter((hit) => mentioned.has(hit.listing.id));

  return {
    conversation: {
      state,
      lastSituation: situation,
      lastReply: reply.text,
      // 追问那一轮虽然没贴卡片，用户屏幕上仍然看得到上一轮的 —— 所以保持 true，
      // 否则连续追问两次，第二次又会把卡片贴回来
      lastShowedCards: showCards || askingAboutShownListings,
      consecutiveClarify: situation === "clarify" ? conversation.consecutiveClarify + 1 : 0,
      transcript: [
        ...(conversation.transcript ?? []),
        { role: "user" as const, text: userText },
        { role: "agent" as const, text: reply.text.slice(0, TRANSCRIPT_CHARS) },
      ].slice(-TRANSCRIPT_TURNS),
      // 卡片没重贴时，用户屏幕上看到的仍是上一批 —— 指代的候选范围不变
      shownIds: showCards
        ? result.hits.map((h) => h.listing.id)
        : (conversation.shownIds ?? []),
    },
    situation,
    reply: reply.text,
    changes,
    dropped: extraction.dropped,
    hits: cards,
    total: result.total,
    commute: toSummary(commute),
    relaxations,
    usage: {
      input: extraction.usage.input + reply.usage.input,
      output: extraction.usage.output + reply.usage.output,
    },
  };
}
