/**
 * 模型调用层 —— 唯一发网络请求的地方。
 *
 * 用 Claude Sonnet 5。注意它的几个约束（都会 400）：
 *   - temperature / top_p / top_k 已移除
 *   - thinking 的 budget_tokens 已移除（只有 adaptive 或 disabled）
 *   - 不支持 assistant prefill —— 用结构化输出代替
 */

import Anthropic from "@anthropic-ai/sdk";

import {
  buildPatchSchema,
  validatePatch,
  type ValidationResult,
} from "./extract.ts";
import type { ConflictInsight } from "./insight.ts";
import type { Relaxation, ScoredListing } from "./search.ts";
import type { RequirementState } from "./state.ts";
import { toSearchQuery } from "./state.ts";
import type { Vocab } from "./vocab.ts";

export const MODEL = "claude-sonnet-5";

/** 抽取结果通过这个工具的参数返回 —— 模型被强制每轮调用它一次 */
const RECORD_TOOL = "record_requirements";

/** key 只在服务端读取，永远不进浏览器 */
export function createClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("缺少 ANTHROPIC_API_KEY —— 用 node --env-file=.env.local 运行");
  }
  // SDK 默认重试 2 次（429 / 5xx / 529 / 连接错误，指数退避）。
  // 调到 4 次：对话是交互式的，一次 529 过载让用户看到报错比多等两秒糟糕得多。
  return new Anthropic({ maxRetries: 4 });
}

// ---------------------------------------------------------------------------
// 需求抽取
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM = `你是新加坡租房助手的需求抽取模块。把用户这一轮说的话，转成一个状态 patch。

规则：
1. 只输出**这一轮新增或改变**的内容。用户没提到的槽位一律不要出现在 set 里 —— 它们会保持原值。
2. 用户明确取消某个条件（"不用能做饭了"、"取消预算限制"）时，把槽位名放进 clear，不要在 set 里写反向的值。
3. 用户说"必须 / 一定要 / must"时，把对应槽位名放进 pin。
4. inferred 的判断标准是**用户有没有要求改这个槽位**，而不是这个数值是不是你算出来的：
   - 用户压根没提，你从上下文猜的（"学生党" → 猜他要单间）→ 放进 inferred
   - 用户明确要求调整，只是没给具体数字（"再便宜点"、"大一点"）→ **不要**放进 inferred，
     这是用户明说要改的，你只是替他算了个数。放进 inferred 会导致这次调整被系统丢弃。
5. 要"把 A 换成 B"时，直接在 set 里写新值就行，**不要**同时把这个槽位放进 clear。
   clear 只用于用户想彻底取消某个条件、之后不再有值的情况。
6. 地点：把用户提到的任何地方（学校、公司、商圈、地铁站）解析成 areas / stations / districts 里**已有的值**。
   选不出就返回空，不要编。解析了就在 locationNote 里用一句话说明你按哪几个地方找的。
   用户说的上班地点、上学地点就按"想住这附近"处理，这是找房时的常识。
   - 指向明确的（"NUS"、"樟宜机场"、"在 Clementi 上班"）→ 解析成周边那几个区域。
   - **范围笼统的（"city"、"市区"、"东边"、"西部"）→ 把该范围内的区域全部列进去，
     不要只挑一个，也不要反问用户。** "east" 就把清单里所有东部区域都填上，
     "city" 就把市中心那一片都填上。然后在 locationNote 里说清楚你按哪几个区找的
     （"「东边」我按 Tampines、Bedok、Pasir Ris、Eunos、Katong 这几个区找的"）。
     用户嫌宽会自己说要哪一个 —— 先给结果比先追问有用得多；说清楚了也就不存在
     "系统替我做了决定我却不知道"的问题。
   - 地点**永远不要**放进 ambiguous。选不出就返回空数组，让系统不带地点约束去搜。
7. **ambiguous 是极少用的出口**，默认不要用。两条铁律：
   - 用户**没提**的字段绝不用 —— 没提 ≠ 歧义，那就是没有这个约束，正常搜就行。
     为一个他从没提过的字段拦下整轮对话，比猜错还烦人：他已经说清要求了，你却不给结果。
   - **地点绝不用** —— 范围笼统就按第 6 条全部列进去，说清楚即可。
   只有当用户的话自相矛盾、或者不问就完全无法继续时才用，每轮最多问一件事。
8. 相对表达（"再便宜点"、"大一点"、"走远点也行"）**不要自己算数字**，放进 adjust
   并只给方向：{ slot: "budgetMax", direction: "down" }。系统会按固定档位算出具体值。
   用户给了明确数字（"最多 1000"）才用 set。
   **用户在评论某一套房源时不要动 adjust。**"这套有点贵""这个位置不方便"是对那套房的
   意见，不是在改整体需求 —— 悄悄把预算下调 10%，用户会看到一个自己没说过的数字。
   只有他明确要求改条件（"给我看便宜点的""预算降到 2000"）才动。
   **adjust 必须有明确指向**：用户得说清楚调的是哪一项（便宜/贵、大/小、远/近、长/短）。
   笼统的同意 —— "放宽一点吧"、"你看着办"、"都行"、"ok 那就松一点" —— **不要**放进 adjust，
   什么都不填就行。他只是同意谈，还没说动哪一条；系统会给他选项，替他挑等于又一次
   替他做决定，而且他会看到一个自己从没说过的数字。
9. 用户上一轮被问了问题、这一轮在回答时，**一定要把答案接住**。
   "city hall i guess"、"就东边吧"、"12 个月" 都是答案 —— 结合上一轮的问题解读，写进 set。
   接不住会导致系统再问一遍同样的问题，这是最让用户恼火的失败。
10. 用户明确表示"别问了，直接给我看"（"just show me"、"你决定"、"随便推荐几个"）时，
    把 wantsResultsNow 设成 true。这时候即使条件很少也要出结果 —— 继续追问比给次优结果更糟。
11. 用户**开口问放宽的事**时，把 wantsRelaxAdvice 设成 true。典型说法：
    "哪个条件最难满足？""我该在哪方面让步？""怎么才能有更多选择？""是不是要求太高了？"
    "which requirement is hardest to meet""what should I compromise on"
    注意和第 8 条的区别：这是**在问建议**，不是在下达调整指令，所以不要动 adjust。
11. 只做抽取，不要回答用户、不要推荐房源。

注意：这套系统没有"国籍"这个筛选维度，schema 里也没有对应字段。用户提出国籍要求时，不要试图用其他字段绕过它。`;

/**
 * 把闭集列进 system prompt。
 *
 * 大闭集进不了 schema 的 enum（会 "Schema is too complex"），所以在这里告诉模型
 * 能选什么。它是稳定前缀，和 system prompt 一起被缓存，每轮对话复用。
 * 模型仍可能返回列表外的值 —— validatePatch 会丢掉，这里只是让它更容易做对。
 */
function vocabBlock(vocab: Vocab): string {
  return [
    "地点只能从下面这三份清单里选，选不出就返回空数组，不要编造：",
    "",
    `区域（${vocab.areas.length}）：${vocab.areas.join(" · ")}`,
    "",
    `地铁站（${vocab.stations.length}）：${vocab.stations.join(" · ")}`,
    "",
    `邮区（${vocab.districts.length}）：${vocab.districts.join(" · ")}`,
    "",
    `设施（${vocab.amenities.length}）：${vocab.amenities.join(" · ")}`,
    "",
    `租客类型：${vocab.occupantTypes.join(" · ")}`,
  ].join("\n");
}

export type ExtractOptions = {
  client: Anthropic;
  state: RequirementState;
  userText: string;
  vocab: Vocab;
  /**
   * 上一轮 agent 说了什么。
   *
   * **少了这个会死循环**：agent 问"Raffles Place、City Hall 还是 Tanjong Pagar？"，
   * 用户答"city hall i guess"，抽取模块只看到这句孤零零的话，接不住，
   * 于是状态没变，下一轮又问一遍。答案必须和问题一起看才有意义。
   */
  lastAgentMessage?: string;
  /** 参考日期，用于把"下个月"这类相对时间算成具体日期 */
  today?: string;
};

export type ExtractOutcome = ValidationResult & {
  /** 这次抽取花了多少 token，便于成本核算 */
  usage: { input: number; output: number };
};

export async function extractRequirements(options: ExtractOptions): Promise<ExtractOutcome> {
  const { client, state, userText, vocab } = options;
  const today = options.today ?? "2026-07-28";

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    // 抽取要快且便宜：关掉 thinking，effort 拉到最低。
    // 输出形状由工具参数表保证，不需要模型自己推敲格式。
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    // 走 tool use 而不是 structured outputs：
    // structured outputs 要把 schema 编译成语法约束，22 个可选槽位就会撞上
    // "Schema is too complex"。非 strict 的工具 schema 不走这条编译路径，
    // 拿到的同样是结构化 JSON（在 tool_use.input 里）。
    tools: [
      {
        name: RECORD_TOOL,
        description: "记录用户这一轮表达的租房需求变化。每一轮都必须调用一次。",
        input_schema: buildPatchSchema(vocab) as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: RECORD_TOOL },
    system: [
      { type: "text", text: EXTRACT_SYSTEM },
      {
        type: "text",
        text: vocabBlock(vocab),
        // 指令 + 词表都是稳定前缀，缓存下来 —— 每轮对话都会复用。
        // 断点打在最后一块，把两块一起缓存。
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `今天是 ${today}。`,
              "",
              "当前已确认的需求（JSON）：",
              JSON.stringify(toSearchQuery(state), null, 2),
              ...(options.lastAgentMessage
                ? [
                    "",
                    "你上一轮对用户说的话（用户很可能是在回答它）：",
                    options.lastAgentMessage,
                  ]
                : []),
              "",
              "用户这一轮说：",
              userText,
            ].join("\n"),
          },
        ],
      },
    ],
  });

  const usage = {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
  };

  const call = response.content.find(
    (block) => block.type === "tool_use" && block.name === RECORD_TOOL,
  );

  if (!call || call.type !== "tool_use") {
    // tool_choice 强制了工具调用，理论上不会走到这里。
    // 真出问题时降级为空 patch 而不是崩掉 —— 状态原样保留，用户可以重说一次。
    return {
      patch: {},
      dropped: [{ slot: "*", value: null, reason: "模型没有调用抽取工具" }],
      ambiguous: [],
      // 什么都没抽到时不能替用户表态：这两个 flag 会让 agent 跳过追问直接出结果，
      // 默认 false 才是安全的那一侧
      wantsResultsNow: false,
      wantsRelaxAdvice: false,
      usage,
    };
  }

  // tool_use.input 已经是解析好的对象，不需要 JSON.parse。
  // 传入当前状态，让相对调整（"再便宜点"）能算出具体数值。
  return { ...validatePatch(call.input, vocab, toSearchQuery(state)), usage };
}

// ---------------------------------------------------------------------------
// 回复生成
// ---------------------------------------------------------------------------

const REPLY_SYSTEM = `你是新加坡租房助手。用户在找房，你根据检索结果回答他。

## 只能用给你的数据
- 每个论断都要能对应到房源卡片上的某个字段值。"步行 8 分钟到 Buona Vista 站（EWL）"可以，"地段很好""性价比高"不行。
- 卡片上没有的信息就说没有，不要推测。房源没写面积，就说"这套没提供面积"。
- **不要对区域、地段、学区、升值潜力做任何评价** —— 你只知道这些房源的字段，不知道它们周边真实是什么样。
- **不要评价价格是否合理**。"这套偏低，注意确认""这个价格很划算"都不行 ——
  数据已经过异常校验，能出现在你面前的价格就是真实价格，你没有依据说它可疑。
  只能陈述事实（"$650／月，同类里偏低"），不能替用户下判断或暗示风险。
- **caveats 已经作为标签显示在卡片上了，不要在正文里逐条复述。**
  只有当某条 caveat 会**改变你的推荐结论**时才提一句 ——
  比如"我最推荐 SG0184，但它要签满 12 个月，你如果只待半年就得看另外那套"。

## 怎么说话
- 先说结论，再说理由。用户问了什么就答什么。
- 简洁。不要把每套房源的每个字段都念一遍，挑对这个用户重要的两三点。
- 不要用"很棒""绝佳""不容错过"这类推销词。
- **绝对不要把检索过程讲给用户听。**"494 套里排除了 475 套""命中 0 条""检索结果"这类话一句都不能出现 ——
  用户要的是"有没有合适的房"，不是你怎么找的。他关心结论和下一步，不关心你的中间步骤。
- **绝不在回答里出现字段名**。给你的数据是 JSON，用户看不到也看不懂它。
  "直接房东出租（directOwner: true）"、"不收中介费（agentFee: none）"、"furnishing 是 partial"
  这类写法一律不行 —— 说人话："房东直租，不收中介费"、"只配了部分家具"。
- 用户用什么语言说话，你就用什么语言回。

## 排名：卡片是按匹配度排好序的
listings 里的 rank 就是界面上卡片的编号，**rank 1 就是系统算出来最匹配的那套**。
- 用户问"你最推荐哪套"、需要指一套时，**默认就是 rank 1** —— 别挑第 4 张说"这是我最推荐的"，
  用户看着 4 号卡片会一头雾水，也会怀疑排序到底有没有用。
- 确实想推荐排名靠后的那套（比如它房东直租能省中介费），**必须挑明**：
  "综合匹配度最高的是 1 号 SG0264，不过如果你在意中介费，4 号 SG0118 是房东直租的。"

## 指代：用户说"这套""that price""there"时指的是谁
recentConversation 里有最近几轮原文，**先读它再回答**。
- 上文刚聊过某一套（比如你说了"我最推荐 SG0118"），那么之后的"这套""that price"
  "can I cook there""能议价吗"**默认就是指那一套** —— 直接答，不要反问"你指哪一套？"。
  用户在一个连贯的对话里，不会每句话都重报一遍房源编号。
- 只有当上文确实没有聚焦到某一套、而问题又只对单套成立时，才问一句是哪套。
- 用户在评论某一套（"这套有点贵""这个位置不太方便"）**不等于**他在改需求。
  那是对这套房的意见，不是新的筛选条件。

## 被问到"有什么是你不知道的"
**只能照抄两份现成清单，不要自己判断哪个字段是空的：**
- 该房源的 missingInfo（代码算好的，可能是空数组 = 这套信息很全）
- 顶层的 notInDataset（整套数据都不包含的东西）

missingInfo 是空的就直说"这套该有的信息都有"，然后只讲 notInDataset。
**绝对不要凭印象说某个字段没有** —— 卡片上写着 594 sqft 你却说"没写面积"，
用户一眼就看出来了，之后你说什么他都不会信。

## cardsShown = false 时
用户是在**追问上一轮已经看过的那批房源**（"top pick 详细说说""哪条约束最难满足"），
这一轮不会把整批卡片重贴一遍。所以：
- **直接答他问的那件事**，别把整批房源重新介绍一遍 —— 他刚看过。
- **你在回复里写到的每一个 id（SG0264 这种），系统会自动把那套的卡片配在下面。**
  所以提到某套时写清 id 就行，价格、面积、地铁这些卡片会显示，你不用逐项复述；
  只讲用户问的那一点，以及卡片上看不出来的判断。
- 答完就停，不要再加"要不要我帮你……"之类的收尾。

## 分支（situation 字段告诉你现在是哪种）
- results：**房源卡片会显示在你这段话下面，用户看得到每套的完整信息。**
  所以**不要逐套罗列**——不要写"1. xxx $650，步行4分钟…… 2. xxx"这种清单，那是在重复卡片。
  你要写的是卡片给不了的东西，三句话以内：
    ① 一共有多少套符合（用 matchCount，**不是** listings 的条数 —— listings 只是展示的前几套）；
    ② 这批房源的整体情况或主要差异（价格跨度、租期长短不一、有几套不能做饭之类）；
    ③ 一句挑选指引 —— 最在意什么的人该看哪一套，用 id 指过去（"最在意通勤的话看 SG0469"）。
  **不要写"几点提醒："然后逐条列 caveat** —— 那些标签卡片上都有。
  真要提，只提影响挑选的那一条，融进 ③ 里说。
- sparse：和 results 一样有房源卡片，但**符合的只有很少几套**。
  照常写 results 那三句，**末尾多加一句提示**："符合的不多，要不要放宽点条件？我看看能多出哪些。"
  同样不要列可以放宽哪些 —— 那是他答应之后的事。
- empty：一条都没匹配上。**先共情一句，然后问他考不考虑放宽条件，就这两句。**
  不要列可以放宽哪些条件，不要摆"最接近的"房源，不要追着他加预算 —— 那都是替他做决定。
- relax：用户愿意谈放宽，或者直接问"哪条最难满足 / 我该让步什么"。
  **relaxations 是按增量降序排的，排第一的那条就是最卡的那条** —— 用户问"哪个最难"时直接这么答：
  "最卡的是预算：放宽到 $2,200 能多出 12 套；租期只影响 2 套。"
  给增量最大的两条，附上各能多出多少套，让他选。不要反问"你更愿意放宽哪一条"就完了 ——
  他问你就是要你给判断，把数字摆出来他才好决定。
  下面如果还有房源卡片，**不要重新介绍它们**（用户刚看过，卡片上也都有）——
  尤其别说"这几套还在"之类的话，他没丢过任何东西，这么说反而像刚才差点没了。
  开门见山答他问的：哪条最卡，放宽它能多出多少。
- conflict：**这几条要求放在一起本身就不存在** —— 不是差一点点，松一档也救不回来。
  说法是：先一句"这几个条件凑在一起找不到房"，然后用 conflictInsight 里的**事实**说明差距在哪。
  conflictInsight 给的是"只保留某一条约束时，库里实际是什么情况"，比如某个区域最便宜的房源是多少钱。
  用它讲差距（"你想住的这一带，最便宜的是 $2,800，和 $1,500 差得比较多"），
  **不要**讲"排除了多少套"——那是检索过程，用户不关心。
  也**不要**用真实世界常识解释（"这里是核心地段所以贵"）—— 只用 conflictInsight 里的数字。
  最后请用户挑一条**大幅**让步（不是松一点）。不要装作还有余地。
- clarify：信息太少还没法检索。问 question 里那**一个**问题，不要连问。

## 敏感字段
房源的 tenantPreferences.nationality 如果带排他性限制，要如实告知用户"这套房东标注了国籍偏好，可能影响你的申请"。
但你**不能**按国籍帮用户筛选房源 —— 系统里没有这个能力，用户提这类要求时说明你做不到，然后继续帮他找房。`;

/**
 * 这套数据里**任何房源都不会有**的信息。
 * 用户问"还有什么你不知道的"时，这些是诚实答案的一部分。
 */
const NOT_IN_DATASET = [
  "门牌号／具体地址细节",
  "房东联系方式",
  "实拍照片",
  "押金金额之外的细节条款",
  "水电费的实际金额",
];

/**
 * 这套房源缺哪些信息 —— **代码算，不让模型自己判断**。
 *
 * 实测踩过：模型说"卡片上没写面积（sizeSqft 是空的）"，而卡片上明明写着 594 sqft；
 * 又说"邮区是系统推断的"，而那套的邮区是房东填的。它没在读数据，在凭印象猜。
 * 哪个字段为空是确定性事实，不该交给模型判断。
 */
function missingInfoOf(l: ScoredListing["listing"]): string[] {
  const missing: string[] = [];
  if (l.sizeSqft === null) missing.push("面积");
  if (l.nearestMrt === null) missing.push("最近的地铁站");
  if (l.district === null) missing.push("邮区");
  else if (l.districtInferred) missing.push("邮区是系统按同区域房源推断的，不是房东填写");
  if (l.amenities.length === 0) missing.push("小区设施清单");
  return missing;
}

/** 送进模型的房源卡片 —— 只放它需要的字段，控制 token 也减少胡说的空间 */
function toCard(hit: ScoredListing, rank: number) {
  const l = hit.listing;
  return {
    /** 匹配度排名，1 = 最匹配。界面上的卡片就是按这个顺序排的 */
    rank,
    id: l.id,
    title: l.title,
    type: `${l.listingType}${l.roomType ? `/${l.roomType}` : ""} · ${l.propertyType}`,
    rentSgd: l.monthlyRentSgd,
    rentNegotiable: l.rentNegotiable,
    priceRankInSameType: l.rentPercentileInCohort,
    area: l.area,
    district: l.district,
    nearestMrt: l.nearestMrt,
    sizeSqft: l.sizeSqft,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    furnishing: l.furnishing,
    leaseMinMonths: l.leaseMinMonths,
    availableFrom: l.availableFrom,
    cookingAllowed: l.cookingAllowed,
    petFriendly: l.petFriendly,
    aircon: l.aircon,
    utilitiesIncluded: l.utilitiesIncluded,
    amenities: l.amenities,
    directOwner: l.directOwner,
    agentFee: l.agentFee,
    matched: hit.matched,
    caveats: hit.caveats,
    /** 这套房源缺的信息 —— 已经由代码算好，不要自己再判断哪个字段是空的 */
    missingInfo: missingInfoOf(l),
    // 只给最能解释这套为什么排前面的三个维度，附字段级证据
    why: hit.breakdown
      .filter((c) => c.raw !== null)
      .sort((a, b) => b.weighted - a.weighted)
      .slice(0, 3)
      .map((c) => c.evidence),
  };
}

export type ReplySituation =
  | "results"
  | "sparse"
  | "empty"
  | "relax"
  | "conflict"
  | "clarify";

export type ReplyOptions = {
  client: Anthropic;
  situation: ReplySituation;
  state: RequirementState;
  userText: string;
  hits: ScoredListing[];
  /** 界面上这次有没有渲染整批房源卡片 —— 决定你是能简写还是得把细节说出来 */
  cardsShown: boolean;
  /** true = 你在回复里点名的房源会自动配上卡片 */
  mentionedCardsShown?: boolean;
  /** 最近几轮对话原文 —— 指代（"that price"、"this place"）全靠它解析 */
  transcript?: Array<{ role: "user" | "agent"; text: string }>;
  /** 用户屏幕上当前看得到的房源 id */
  shownIds?: string[];
  total: number;
  pool: number;
  relaxations?: Relaxation[];
  /** conflict 分支专用：只保留单条约束时，库里实际是什么情况 */
  conflictInsight?: ConflictInsight;
  question?: string;
  locationNote?: string;
};

export type ReplyOutcome = {
  text: string;
  /** 这一轮实际展示给用户的房源 id —— 便于前端高亮和后续追问定位 */
  shownIds: string[];
  usage: { input: number; output: number };
};

export async function generateReply(options: ReplyOptions): Promise<ReplyOutcome> {
  const { client, situation, state, userText, hits, total, pool } = options;
  const cards = hits.map((hit, index) => toCard(hit, index + 1));

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    // 回复要有判断力（取舍怎么讲、哪些 caveat 值得说），开 adaptive thinking。
    // effort 用 medium：再高会开始过度铺陈，对话里读起来累。
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: [{ type: "text", text: REPLY_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                situation,
                recentConversation: options.transcript,
                listingsOnScreen: options.shownIds,
                userSaid: userText,
                understoodRequirements: toSearchQuery(state),
                locationNote: options.locationNote,
                /** 符合条件的总数 —— 讲给用户听的是这个 */
                matchCount: total,
                /** 下面展示了几套 —— 只是 UI 展示条数，别说成"找到 N 套" */
                shownCount: cards.length,
                /** false = 这一轮界面上没有卡片，用户是在追问上一轮已经看过的房源 */
                cardsShown: options.cardsShown,
                totalListings: pool,
                listings: cards,
                /** 整套数据都不包含的信息 —— 回答"你还有什么不知道"时用 */
                notInDataset: NOT_IN_DATASET,
                relaxations: options.relaxations,
                conflictInsight: options.conflictInsight,
                question: options.question,
              },
              null,
              2,
            ),
          },
        ],
      },
    ],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();

  return {
    text,
    shownIds: hits.map((h) => h.listing.id),
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}
