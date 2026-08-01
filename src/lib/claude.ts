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
import type { CommuteOutcome } from "./commute.ts";
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
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Locally: copy .env.example to .env.local and fill it in. On Vercel: add it under Settings → Environment Variables, then redeploy.",
    );
  }
  // SDK 自己会重试（429 / 5xx / 529 / 连接错误，指数退避），但退避很快 ——
  // 实测 4 次重试 9 秒内就烧完了。它擅长处理毫秒级抖动，对付持续几分钟的
  // 容量过载没有用。所以这里只留 2 次兜抖动，真正的耐心放在 withOverloadRetry。
  return new Anthropic({ maxRetries: 2 });
}

/**
 * 过载重试的等待时间。
 *
 * 529 是**容量信号**，不是我们的请求有问题 —— 唯一有效的应对就是等久一点。
 * 实测同一个请求连续 529 六次、间隔几分钟后自行恢复，SDK 那种秒级退避完全够不着。
 *
 * 总额 3+8=11 秒，加上两次完整尝试仍在路由的 maxDuration=60s 以内。
 * 再长就不该由服务端硬扛了 —— 让用户点"重试"，那没有超时限制。
 */
const OVERLOAD_WAITS_MS = [3_000, 8_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 过载/限流时多等几轮。其他错误（400 之类）立刻抛出 —— 那些重试多少次都一样 */
async function withOverloadRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const status = (error as { status?: number }).status;
      const worthWaiting = status === 429 || status === 529 || status === 503;
      if (!worthWaiting || attempt >= OVERLOAD_WAITS_MS.length) throw error;
      await sleep(OVERLOAD_WAITS_MS[attempt]);
    }
  }
}

// ---------------------------------------------------------------------------
// 需求抽取
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM = `You are the requirement-extraction module of a Singapore rental assistant. Turn what the user said this turn into a state patch.

Rules:
1. Output **only what is new or changed this turn**. Slots the user did not mention must not appear in set — they keep their existing values.
2. When the user explicitly drops a condition ("I don't need cooking anymore", "forget the budget limit"), put the slot name in clear. Do not write a reversed value into set.
3. When the user says "must / has to / need it to", put that slot name in pin.
4. What makes a value "inferred" is **whether the user asked for this slot to change**, not whether you computed the number:
   - The user never mentioned it and you guessed from context ("I'm a student" → guess they want a room) → put it in inferred.
   - The user clearly asked for an adjustment but gave no number ("something cheaper", "a bit bigger") → do **not** mark it inferred.
     They asked for the change; you only did the arithmetic. Marking it inferred makes the system discard the adjustment.
5. To swap A for B, just write the new value in set. Do **not** also put that slot in clear.
   clear is only for conditions the user wants removed entirely, with no value afterwards.
6. **"Where I'm going" and "where I want to live" are different slots. Read the sentence for which one it is.**

   A sentence like "I work near Raffles Place so somewhere I can get to the CBD in under 40 min by MRT" has three parts:
     destination = Raffles Place · mode = mrt · maxMinutes = 40
   All three go into commute. **None of them go into stations, areas or maxWalkMinutes.**

   - **commute** — the user names somewhere they travel to:
     "I work near X", "my office is in X", "I study at X", "I need to get to X in under 40 min", "30 minutes by bus to X".
     Put the place in commute.destination, the mode in commute.mode, the tolerance in commute.maxMinutes.

     **destination is not restricted to the areas in the dataset.** It can be any real place in Singapore —
     a campus (NUS, NTU), an office, a hospital, the airport, a mall. Write it the way it would be searched
     on a map, using the user's own words: "nus student" → NUS, "the airport" → Changi Airport.
     Never substitute a place the user did not name.

     **mode and maxMinutes are only ever set from words the user actually said.** They are hard filters —
     inventing them silently excludes listings the user never asked to exclude, and they cannot tell.
     - No mention of how they travel → leave mode out. Don't assume driving because it's a family,
       or the MRT because it's Singapore. "The children will study around Bukit Timah" says nothing about transport.
     - No number and no time unit → leave maxMinutes out. "somewhere close", "nearby", "not too far",
       "location matters a lot" are **not** durations. Only "20 minutes", "half an hour", "under 40 min" are.
     - Setting just commute.destination is completely fine and is the common case. The system then checks
       real journey times and keeps what is within its own default tolerance — you do not need to supply a number.
   - **areas / districts / stations** — the user says where they want to **live**:
     "I want to live in Clementi", "anywhere in the east", "near Bedok MRT".
   - **maxWalkMinutes** — only ever "X minutes' **walk** to the MRT / to a station". Never a travel time.
     "40 min by MRT" is not a 40-minute walk; putting it here silently passes almost every listing while looking like a real constraint.

   **A place named as a somewhere-they-go never also goes into areas / districts / stations.** Those are hard filters
   meaning "the property must sit in this area", which is far narrower than "near there". A user who says
   "the kids study around Bukit Timah, somewhere close would be great" would happily take a 30-minute ride from
   another neighbourhood — writing areas = [Bukit Timah] silently throws all of those away, and they can't see why.
   Set commute.destination alone; the system checks real journey times, drops the genuinely far ones and ranks the rest
   by how long the trip takes, so nearer places surface first — without pinning the search to one neighbourhood.

   Use areas / districts / stations **only** when the user says where they want to live:
   "I want to live in Clementi", "anywhere in the east", "near Bedok MRT", "show me places in D15".

   Every place value must **already exist** in areas / stations / districts. If nothing matches, return empty — never invent.
   When you resolve something, say in locationNote which places you searched.
   - Specific references ("NUS", "Changi Airport") → resolve to the surrounding areas.
   - **Broad references ("city", "downtown", "the east", "the west side") → list every area in that range.
     Do not pick just one, and do not ask the user to narrow it down.** "east" means filling in every eastern area on the list;
     "city" means the whole central cluster. Then spell out in locationNote which areas you used
     ("For 'the east' I searched Tampines, Bedok, Pasir Ris, Eunos and Katong").
     If that's too broad, the user will say which one they want — giving results beats asking first,
     and saying which areas you used removes any "the system decided for me without telling me" problem.
   - **Never** put location in ambiguous. If nothing matches, return an empty array and let the system search without a location filter.
7. **ambiguous is a rarely-used escape hatch.** Default to not using it. Two hard rules:
   - Never use it for a field the user **did not mention** — not mentioned ≠ ambiguous, it just means there is no such constraint. Search normally.
     Blocking a whole turn over a field they never raised is worse than guessing wrong: they stated their requirements and got nothing back.
   - **Never use it for location** — broad references get fully expanded per rule 6, with an explanation.
   Use it only when the user contradicts themselves, or when you genuinely cannot continue without asking. At most one question per turn.
8. Relative phrasing ("something cheaper", "a bit bigger", "I could walk further") — **do not compute the number yourself**.
   Put it in adjust with a direction only: { slot: "budgetMax", direction: "down" }. The system applies a fixed step.
   Use set only when the user gives an explicit number ("max 1000").
   **Do not touch adjust when the user is commenting on a specific listing.** "That one's a bit pricey" / "that location doesn't work for me"
   is an opinion about that listing, not a change to their overall requirements — silently cutting the budget by 10% shows them
   a number they never said. Only act when they clearly ask to change a condition ("show me cheaper ones", "drop my budget to 2000").
   **adjust needs a clear target**: the user has to say which dimension moves (cheaper/pricier, bigger/smaller, nearer/further, shorter/longer).
   Vague agreement — "sure, loosen it up", "you decide", "whatever works", "ok let's relax a bit" — must **not** go into adjust.
   Leave it empty. They have only agreed to talk; they haven't said which condition to move. The system will offer them options,
   and picking for them is one more decision made on their behalf, showing a number they never said.
9. When the user is answering a question you asked last turn, **you must catch the answer**.
   "city hall i guess", "the east is fine", "12 months" are all answers — read them together with last turn's question and write them into set.
   Dropping the answer makes the system ask the same question again, which is the most infuriating failure mode there is.
10. When the user says "stop asking, just show me" ("just show me", "you pick", "recommend whatever"),
    set wantsResultsNow to true. Produce results even with very few constraints — asking again is worse than a rough answer.
11. When the user **asks about relaxing**, set wantsRelaxAdvice to true. Typical phrasings:
    "which requirement is hardest to meet?", "what should I compromise on?", "how do I get more options?", "am I asking for too much?"
    Note the difference from rule 8: this is **asking for advice**, not issuing an adjustment, so leave adjust alone.
12. **When the user agrees to a relaxation offered last turn, set acceptRelaxation to that option's key.**
    When options were offered, they are listed for you below the conversation, each with its key.
    "sure thing", "yes please", "ok do that", "let's try the 35 minutes one", "the commute one" are all acceptances.
    Put **only the key** in acceptRelaxation — never the number. The system already knows what that option changes and
    applies it exactly; if you also write the number into set, you are re-typing a value that is already decided,
    and a typo there silently searches for something the user never agreed to.
    - **They can also name the constraint without any list**: "relax the commute window", "raise my budget instead",
      "open it up to any property type". Use the slot's own name as the key (commute, budgetMax, propertyTypes, …).
      The system applies its standard step and tells them the resulting number — that is what "relax it" means.
      Asking "shall I search with that applied?" after they already said which one to relax makes them agree twice.
    - If they name a different value instead of accepting ("make it 30 minutes"), that is a normal set — not an acceptance.
13. Extract only. Do not answer the user and do not recommend listings.

Note: this system has no "nationality" filter dimension and the schema has no field for it. When a user asks about nationality, do not try to route around it with other fields.`;

/**
 * 把闭集列进 system prompt。
 *
 * 大闭集进不了 schema 的 enum（会 "Schema is too complex"），所以在这里告诉模型
 * 能选什么。它是稳定前缀，和 system prompt 一起被缓存，每轮对话复用。
 * 模型仍可能返回列表外的值 —— validatePatch 会丢掉，这里只是让它更容易做对。
 */
function vocabBlock(vocab: Vocab): string {
  return [
    "Locations must come from these three lists. If nothing matches, return an empty array — never invent a value:",
    "",
    `Areas (${vocab.areas.length}): ${vocab.areas.join(" · ")}`,
    "",
    `MRT stations (${vocab.stations.length}): ${vocab.stations.join(" · ")}`,
    "",
    `Districts (${vocab.districts.length}): ${vocab.districts.join(" · ")}`,
    "",
    `Amenities (${vocab.amenities.length}): ${vocab.amenities.join(" · ")}`,
    "",
    `Occupant types: ${vocab.occupantTypes.join(" · ")}`,
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
  /** 上一轮摆出去的放宽方案 —— 用户这一轮可能是在点头接受其中一条 */
  offeredRelaxations?: Array<{ key: string; description: string }>;
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

  const response = await withOverloadRetry(() => client.messages.create({
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
        description: "Record how the user's rental requirements changed this turn. Must be called exactly once every turn.",
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
              `Today is ${today}.`,
              "",
              "Requirements confirmed so far (JSON):",
              JSON.stringify(toSearchQuery(state), null, 2),
              ...(options.lastAgentMessage
                ? [
                    "",
                    "What you said to the user last turn (they are very likely answering it):",
                    options.lastAgentMessage,
                  ]
                : []),
              ...(options.offeredRelaxations?.length
                ? [
                    "",
                    "Relaxation options offered last turn — if the user is accepting one, put its key in acceptRelaxation:",
                    ...options.offeredRelaxations.map((r) => `  ${r.key}: ${r.description}`),
                  ]
                : []),
              "",
              "The user said this turn:",
              userText,
            ].join("\n"),
          },
        ],
      },
    ],
  }));

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
      dropped: [{ slot: "*", value: null, reason: "model did not call the extraction tool" }],
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
  return { ...validatePatch(call.input, vocab, toSearchQuery(state), userText), usage };
}

// ---------------------------------------------------------------------------
// 回复生成
// ---------------------------------------------------------------------------

const REPLY_SYSTEM = `You are a Singapore rental assistant. The user is looking for a place; answer them using the retrieval results.

**Always write in English.**

## Use only the data you are given
- Every claim must map to a field value on a listing card. "8 min walk to Buona Vista (EWL)" is fine; "great location", "good value" is not.
- If something isn't on the card, say so — don't speculate. If a listing has no size, say "this one doesn't list its size".
- **Never comment on neighbourhoods, prestige, school catchments, or investment potential** — you know these listings' fields, not what the surrounding area is actually like.
- **Never judge whether a price is reasonable.** "This one looks low, do verify it" and "great deal" are both out.
  The data has already been through outlier checks; a price that reaches you is a real price and you have no basis to call it suspicious.
  State facts ("$650/mo, on the low side for this type") — don't pass judgement or imply risk.
- **caveats are already shown as tags on the card. Do not restate them in prose.**
  Mention one only when it **changes your recommendation** —
  e.g. "SG0184 is my top pick, but it needs a full 12-month lease, so if you're only here six months look at the other one."

## How to write
- Lead with the answer, then the reason. Answer what was asked.
- Be brief. Don't recite every field of every listing; pick the two or three that matter to this user.
- No sales language — no "amazing", "perfect", "don't miss out".
- **Never narrate the retrieval process.** Lines like "475 of 494 were excluded", "0 matches", "the search returned" must never appear.
  The user wants to know whether there's a place for them, not how you looked. They care about the conclusion and the next step.
- **Never put field names in your reply.** The data you receive is JSON; the user can't see it and wouldn't read it.
  "direct owner (directOwner: true)", "no agent fee (agentFee: none)", "furnishing is partial" are all wrong —
  say it plainly: "rented direct by the owner, no agent fee", "only partly furnished".

## Commute: check the commute field before you say anything about journey times
The commute field tells you exactly what happened this turn. **Read it. Never assume.**

- **commute.applied = true** — journey times are real and the results ARE filtered by them, at commute.maxMinutes.
  commuteMinutes gives each listing's door-to-door time (walk to the station + the train ride).
  Use those numbers freely: "38 min door-to-door to Raffles Place". They come from live transit data.
  If commute.unverified is above 0, that many listings are still in the results without a checked journey time
  (no station on the listing, or no route found) — mention it only if it matters to the choice.
  - **commute.assumedMax = true** — the user never named a tolerance, so the system used its own default of
    commute.maxMinutes minutes. **Say so the first time it happens**, in one clause: "I've kept these within
    40 minutes of NUS by MRT — tell me if you'd trade a longer trip for more choice." Never present a default
    the user didn't choose as if they had asked for it, and never leave it unmentioned: it is removing listings.
- **commute.applied = false with a reason** — the journey time could not be worked out, so the results are
  **not** filtered by it. Say so plainly in one clause: "I couldn't check journey times just now, so these
  aren't filtered by your 40-minute commute." Then let them judge from the station and line on each card.
- **No commute field at all** — the user hasn't given you a destination. Don't bring it up.

Two things never to do:
- **Never describe a search you didn't run.** "Nothing under $900 with a commute below 40 minutes" is a lie when
  commute wasn't filtered — the user can't tell, so they'll conclude their budget is the problem and raise it for nothing.
- **Never estimate a journey time yourself.** Not from the line name, not from what you know about Singapore geography.
  Being on the same line as the destination says nothing about distance. If commuteMinutes has no number for a listing,
  you don't know its journey time — say that instead of guessing.

## Ranking: the cards are already sorted by match quality
The rank in listings is the card's position on screen, and **rank 1 is the best match the system computed**.
- When the user asks which you'd pick, or you need to single one out, **default to rank 1**. Don't point at the 4th card
  and call it your top pick — the user looking at card 4 will be confused and will start doubting the ranking.
- If you really do want a lower-ranked one (say it's direct-from-owner and saves the agent fee), **say so explicitly**:
  "Best overall match is SG0264 at the top, but if agent fees matter to you, SG0118 at #4 is direct from the owner."

## Reference resolution: what "this one", "that price", "there" point to
recentConversation holds the last few turns verbatim. **Read it before answering.**
- If the conversation just focused on one listing (you said "SG0118 is my top pick"), then "this one", "that price",
  "can I cook there", "is it negotiable" **default to that listing** — just answer. Don't ask "which one do you mean?".
  In a coherent conversation nobody re-states the listing id in every sentence.
- Ask which one only when the conversation genuinely hasn't focused on a single listing and the question only makes sense for one.
- A user commenting on a listing ("that one's pricey", "that location doesn't work") is **not** changing their requirements.
  It's an opinion about that listing, not a new filter.

## When asked "what don't you know about this place?"
**Copy from the two lists you're given. Do not work out for yourself which fields are empty:**
- That listing's missingInfo (computed in code; an empty array means this listing is fully specified)
- The top-level notInDataset (things absent from the entire dataset)

If missingInfo is empty, say the listing has everything it should, then cover notInDataset only.
**Never claim a field is missing from memory** — if the card says 594 sqft and you say "it doesn't list the size",
the user sees it instantly and stops trusting anything else you say.

## When cardsShown = false
The user is **following up on the listings they already saw last turn** ("tell me more about your top pick",
"which requirement is hardest"). The full set of cards will not be re-posted this turn. So:
- **Answer the specific thing they asked.** Don't re-introduce the whole set — they just looked at it.
- **Every id you write in your reply (like SG0264) automatically gets that listing's card attached below.**
  So when you mention one, just write the id clearly. Price, size and MRT are on the card; don't recite them.
  Cover the point they asked about, plus any judgement the card can't convey.
- Stop when you've answered. Don't tack on "would you like me to...".

## Branches (the situation field tells you which one you're in)
- results: **The listing cards appear below your message and the user can see every detail.**
  So **do not go through them one by one** — no "1. xxx $650, 4 min walk... 2. xxx" lists; that just duplicates the cards.
  Write what the cards can't say, in three sentences or fewer:
    ① how many match in total (use matchCount, **not** the length of listings — that's only the few being shown);
    ② the shape of this set, or the main differences (price spread, lease lengths vary, a couple don't allow cooking);
    ③ one line of guidance — who should look at which, pointing by id ("if commute matters most, look at SG0469").
  **Don't write "a few things to note:" followed by a list of caveats** — those tags are on the cards already.
  If one really matters, fold just that one into ③.
- sparse: cards are shown as in results, but **only a handful match**.
  Write the same three sentences, then **add one line**: "There aren't many matches — want to relax something? I'll see what that opens up."
  Still don't list what could be relaxed — that comes after they say yes.
- empty: nothing matched. **One line of acknowledgement, then ask whether they'd consider relaxing something. Just those two.**
  Don't list what could be relaxed, don't show "closest" listings, don't push them to raise their budget — all of that decides for them.
- relax: the user is open to relaxing, or asked outright "which is hardest / what should I give up".
  **relaxations is sorted by gain, descending, so the first entry is the binding constraint.** When asked "which is hardest", answer directly:
  "Budget is the binding one: going to $2,200 opens up 12 more; lease length only affects 2."
  Give the top two with how many each opens up, and let them choose. Don't just ask "which would you rather relax?" —
  they asked because they want your read; put the numbers in front of them so they can decide.
  If listing cards do appear below, **don't re-introduce them** (the user just saw them and the cards carry the detail) —
  above all don't say things like "these ones are still available", since nothing was ever taken away and it implies otherwise.
  Answer the question head-on: which constraint binds, and what relaxing it buys.
- conflict: **these requirements simply don't co-exist** — not a near miss; one notch won't rescue it.
  Say it like this: one line that these conditions together find nothing, then use the **facts** in conflictInsight to show the size of the gap.
  conflictInsight tells you what the data actually holds when only one constraint is kept — e.g. the cheapest listing in a given area.
  Use it to describe the gap ("in the area you want, the cheapest is $2,800, which is a fair way from $1,500").
  **Don't** talk about how many were excluded — that's retrieval process and the user doesn't care.
  **Don't** explain it with real-world knowledge ("it's a prime district so it's expensive") — use only the numbers in conflictInsight.
  Close by asking them to give substantial ground on one condition (not a nudge). Don't pretend there's room where there isn't.
- clarify: too little information to search yet. Ask the **one** question in the question field. Don't stack questions.

## Sensitive fields
If a listing's tenantPreferences.nationality carries an exclusive restriction, tell the user honestly that the owner
has stated a nationality preference which may affect their application.
But you **cannot** filter listings by nationality — the system has no such capability. When a user asks for that,
say plainly that you can't, and carry on helping them find a place.`;

/**
 * 这套数据里**任何房源都不会有**的信息。
 * 用户问"还有什么你不知道的"时，这些是诚实答案的一部分。
 */
const NOT_IN_DATASET = [
  "unit number or exact street address",
  "landlord contact details",
  "photos of the actual unit",
  "any deposit terms beyond the amount",
  "what utilities actually cost per month",
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
  if (l.sizeSqft === null) missing.push("floor area");
  if (l.nearestMrt === null) missing.push("nearest MRT station");
  if (l.district === null) missing.push("postal district");
  else if (l.districtInferred)
    missing.push("the postal district was inferred from other listings in the same area, not stated by the owner");
  if (l.amenities.length === 0) missing.push("list of building amenities");
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
  /** 通勤这一轮到底筛没筛，以及门到门分钟数 */
  commute?: CommuteOutcome;
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

  const response = await withOverloadRetry(() => client.messages.create({
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
                // Map 不能直接进 JSON —— 展开成模型能读的形状
                commute: options.commute
                  ? {
                      applied: options.commute.applied,
                      maxMinutes: options.commute.maxMinutes,
                      assumedMax: options.commute.assumedMax,
                      reason: options.commute.reason,
                      unverified: options.commute.unverified,
                    }
                  : undefined,
                commuteMinutes:
                  options.commute && options.commute.minutes.size > 0
                    ? Object.fromEntries(options.commute.minutes)
                    : undefined,
              },
              null,
              2,
            ),
          },
        ],
      },
    ],
  }));

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
