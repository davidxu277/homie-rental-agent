# Homie AI Engineering Internship — Take-home Assignment (English)

> 中文版见 `assignment-cn.md`。

## Background

We now need to build an AI-powered rental assistant for Singapore that helps people make faster,
safer decisions while searching for a home. Real house-hunting is a **multi-turn conversation**,
where several things tend to happen: the user's needs aren't clearly stated, those needs change,
budget and expectations often conflict, and the listing data is fairly noisy. You will design and
build an AI agent for this scenario.

## The Task

Build a **Singapore Rental Agent**: a **multi-turn conversational** product that can

1. **Understand and clarify** a user's rental needs (budget, location, property type, commute,
   lifestyle preferences…) — asking follow-up questions when the request is underspecified;
2. **Retrieve and recommend** suitable listings from the database we provide, with reasons, a
   sense of match quality, and any caveats worth flagging;
3. **Answer follow-up questions** about specific listings (e.g. "can I cook here?", "how far is
   it from NUS?", "is the rent negotiable?", "are utilities included?") and let the user **change
   their constraints mid-conversation** and get updated recommendations.

This is an open-ended assignment with **no single correct answer**. We care more about your
thinking, your trade-offs and your ability to ship than about covering every feature.

## The data we provide (`data/` folder)

- **`data/listings.json`** — 502 **synthetic** Singapore listings (shaped to resemble the local
  market, but entirely fake — please do not swap in real scraped data).
- **`data/data-dictionary.md`** — the field schema. **Please read it.** Some rows carry
  **dirty / edge-case data** (missing fields, non-standard field formats, duplicate rows, etc.),
  plus an **ethics note about sensitive fields (nationality / gender preferences)**.
- **`data/conversations/`** — 10 sample user sessions (persona, situation, and the user's turns).
  There are **no reference replies**. Difficulty ranges from easy to hard and includes
  contradictory requirements, budget compromises, a mid-conversation change of mind, a cold start
  with almost no information, and a sensitive request.

> **Reference date:** treat "today" as **2026-07-28**.

## Deliverables

### 1. Product demo (a live website)
A **deployed, usable** website that exercises the core conversation flow (any platform — Vercel /
Render / Railway / Fly, etc.). We will open it and try it ourselves.

### 2. GitHub repository
Complete code, can be temporarily public. A clear structure is enough — **no heavy engineering
setup required.** Please include the `data/` folder in the repo.

### 3. README (your thinking and build process)
In the README (or a separate doc), cover:

- **Product design** — What product did you decide to build? For whom, and what problem does it
  solve? How did you design the conversational + recommendation experience, and why?
- **AI agent system design** — What's the overall architecture? How do you extract and manage the
  user's requirements (conversation state)? How do you do retrieval and recommendation? Which AI
  capabilities did you use and why?
- **Engineering** — tech stack, data flow, how you handled the dirty data, how you deployed.
- **Product thinking & trade-offs** — how did you handle the hard cases (contradictory needs,
  sensitive requests, no perfect match), and why?
- **Development process** — how you approached it, what went wrong, how you solved it.
- **What you'd improve** — with more time, what next?

## Technical notes

- Your solution should genuinely use **AI (an LLM)** to drive the conversation and
  recommendations.
- **Vibe coding** is encouraged. No restriction on tech stack.
- You must use the provided `data/` as your listing database — do not connect to real listings.
- If paid-model cost is a concern, say so in the README. We value the approach; you don't need to
  spend money to impress us.

## What we evaluate

| Dimension | What we look for |
|---|---|
| **AI agent system design** | conversation-state management, retrieval/recommendation architecture, grounding (no hallucination), handling of hard cases |
| **Product design & thinking** | clear positioning, an experience that solves a real pain point, well-reasoned trade-offs |
| **Engineering** | code structure, robustness against dirty data, deployable and runnable |
| **Delivery & communication** | is the site actually usable, does the README explain your thinking |

This is open-ended — we are not looking for feature completeness. **Making the right trade-offs
in limited time and doing the parts you scoped *well* matters more than piling on features.**

## Time expectation

We suggest **1–3 days**.

## Submission

Send your **GitHub repo link** and **live site link** to **hiring@homieaiagent.com**, with a
subject line like "Assignment Submission — <your name>".

Questions are welcome by email. Have fun 🙂
