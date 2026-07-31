# Assignment Data

Everything in this folder is **synthetic** and provided for the take-home assignment.
Use it as your listing database and your conversation test set. Do **not** replace it with
real scraped data — we want everyone evaluated on the same corpus.

## Contents

```
data/
├── listings.json          # 502 fake Singapore rental listings (your "database")
├── data-dictionary.md     # field-by-field schema + the dirty-data / ethics notes — READ THIS
└── conversations/         # 10 sample user sessions to test your agent against
    ├── session-01-budget-intern.json
    ├── ...
    └── session-10-open-cold-start.json
```

## `listings.json`

A JSON array of listing objects. See **`data-dictionary.md`** for every field, the MRT line
codes, and — importantly — the ~12% of rows with intentional dirty / edge-case values. Assume
the feed is messy.

## `conversations/`

Each file is one user session. It contains a **persona**, a **situation**, and an ordered list
of **user turns** — i.e. what the user types, turn by turn. There are **no reference assistant
replies**: we don't want you pattern-matching to a "model answer". Sessions range from `easy` to
`hard` (see the `difficulty` field); the hard ones include contradictory requirements, budget
compromises, a change of mind mid-conversation, a cold start with almost no information, and a
sensitive request. Your agent should handle the full spread.

Use these sessions to develop and demo your agent. You're welcome to add your own as well.

## Reference date

Treat **today as 2026-07-28** when reasoning about `availableFrom`.
