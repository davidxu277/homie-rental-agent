"use client";

import { useEffect, useRef, useState } from "react";

import type { Conversation, TurnResult } from "../src/lib/agent.ts";
import { emptyState, slotLabel, toSearchQuery, type SlotKey } from "../src/lib/state.ts";
import type { ScoredListing } from "../src/lib/search.ts";

type Turn = {
  user: string;
  reply?: string;
  hits?: ScoredListing[];
  error?: string;
};

const EXAMPLES = [
  "Looking for a room, budget around $1,200",
  "Any whole units near Clementi?",
  "Needs to allow cooking and a cat",
];

/** 侧栏里怎么显示一个槽位的值 */
function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
}

export default function Page() {
  const [conversation, setConversation] = useState<Conversation>({
    state: emptyState(),
    lastSituation: null,
    consecutiveClarify: 0,
  });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  async function send(text: string) {
    const userText = text.trim();
    if (!userText || busy) return;

    setDraft("");
    setBusy(true);
    setTurns((prev) => [...prev, { user: userText }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation, userText }),
      });
      const data = (await response.json()) as TurnResult & { error?: string };

      if (!response.ok || data.error) {
        setTurns((prev) =>
          prev.map((t, i) => (i === prev.length - 1 ? { ...t, error: data.error } : t)),
        );
        return;
      }

      setConversation(data.conversation);
      setTurns((prev) =>
        prev.map((t, i) =>
          i === prev.length - 1 ? { ...t, reply: data.reply, hits: data.hits } : t,
        ),
      );
    } catch {
      setTurns((prev) =>
        prev.map((t, i) =>
          i === prev.length - 1 ? { ...t, error: "Request failed — please try again." } : t,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  const query = toSearchQuery(conversation.state);
  const slots = Object.entries(query) as Array<[SlotKey, unknown]>;

  return (
    <div className="shell">
      <div className="main">
        <div className="head">
          <h1>Singapore Rental Assistant</h1>
          <p>Just tell me your situation — budget, where you want to live, when you need to move in</p>
        </div>

        <div className="thread" ref={threadRef}>
          {turns.length === 0 && (
            <div className="empty-hint">
              <div>Say anything to get started, for example:</div>
              <div className="examples">
                {EXAMPLES.map((example) => (
                  <button key={example} type="button" onClick={() => send(example)}>
                    {example}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((turn, index) => (
            // biome-ignore lint: 对话是追加式的，索引可以作为稳定 key
            <div key={index} style={{ display: "contents" }}>
              <div className="turn user">
                <div className="bubble">{turn.user}</div>
              </div>

              {turn.error && (
                <div className="turn agent">
                  <div className="error">{turn.error}</div>
                </div>
              )}

              {turn.reply && (
                <div className="turn agent">
                  <div className="bubble">{turn.reply}</div>
                  {turn.hits && turn.hits.length > 0 && (
                    <div className="cards">
                      {turn.hits.map((hit, rank) => (
                        <ListingCard key={hit.listing.id} hit={hit} rank={rank + 1} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {busy && (
            <div className="turn agent">
              <div className="status">
                <span className="dot" />
                Understanding your requirements and searching…
              </div>
            </div>
          )}
        </div>

        <div className="composer">
          <textarea
            rows={1}
            value={draft}
            placeholder="Tell me what you're looking for… (Enter to send, Shift+Enter for a new line)"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(draft);
              }
            }}
          />
          <button type="button" onClick={() => send(draft)} disabled={busy || !draft.trim()}>
            Send
          </button>
        </div>
      </div>

      <aside className="side">
        <h2>What I've understood</h2>
        <p className="sub">These are the conditions currently used to search</p>

        {slots.length === 0 ? (
          <div className="none">Nothing confirmed yet</div>
        ) : (
          <div className="slots">
            {slots.map(([slot, value]) => (
              <div className="slot" key={slot}>
                <span className="k">{slotLabel(slot)}</span>
                {conversation.state.meta[slot]?.pinned && <span className="pin">must</span>}
                <span className="v">{renderValue(value)}</span>
                {/* 点 × 不是偷偷改状态，而是替用户说一句话 —— 走同一条抽取管线，
                    对话记录里也留得下痕迹，用户看到的和系统做的始终一致 */}
                <button
                  type="button"
                  className="x"
                  title={`Remove "${slotLabel(slot)}"`}
                  disabled={busy}
                  onClick={() => send(`Drop the ${slotLabel(slot).toLowerCase()} requirement`)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {turns.length > 0 && (
          <button
            type="button"
            className="reset"
            onClick={() => {
              setConversation({ state: emptyState(), lastSituation: null, consecutiveClarify: 0 });
              setTurns([]);
            }}
          >
            Start over
          </button>
        )}
      </aside>
    </div>
  );
}

function ListingCard({ hit, rank }: { hit: ScoredListing; rank: number }) {
  const l = hit.listing;
  const mrt = l.nearestMrt;

  return (
    <div className="card">
      <div className="card-top">
        <span className="card-title">
          {/* id 是回复里指路用的主标识（"排名第一的 SG0264"），做成醒目徽章；
              排名做成上标附在旁边，够用又不抢戏 */}
          <span className="lid">
            {l.id}
            <span className="rank">#{rank}</span>
          </span>
          {l.title}
        </span>
        <span className="card-rent">
          {l.monthlyRentSgd === null ? "—" : `$${l.monthlyRentSgd.toLocaleString()}`}
          <span style={{ color: "var(--mute)", fontWeight: 400 }}> /mo</span>
        </span>
      </div>

      <div className="card-meta">
        <span>{l.area}</span>
        {l.district && <span>{l.district}</span>}
        <span>{l.sizeSqft === null ? "Size not listed" : `${l.sizeSqft} sqft`}</span>
        <span>
          {mrt ? `${mrt.walkMinutes} min walk to ${mrt.station} (${mrt.line})` : "No MRT info"}
        </span>
        <span>{l.leaseMinMonths}-month min lease</span>
        <span>From {l.availableFrom}</span>
      </div>

      <div className="chips">
        {hit.matched.map((label) => (
          <span className="chip" key={label}>
            ✓ {label}
          </span>
        ))}
        {hit.caveats.map((caveat) => (
          <span className="chip caveat" key={caveat}>
            ⚠ {caveat}
          </span>
        ))}
      </div>
    </div>
  );
}
