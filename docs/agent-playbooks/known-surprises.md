# Known Surprises

This file tracks repository-specific confusion points that caused agent mistakes.

## Entry Criteria

Add an entry only if all are true:

- It is specific to this repository, not generic advice.
- It is likely to recur for future agents.
- It has a concrete mitigation that can be followed.

If uncertain, ask the developer before adding an entry.

## Entry Template

```md
### [Short title]

- **Date:** YYYY-MM-DD
- **Observed by:** agent name or contributor
- **Context:** where/when it happened
- **What was surprising:** concrete unexpected behavior
- **Impact:** what went wrong or could go wrong
- **Mitigation:** exact step future agents should take
- **Status:** confirmed | superseded
```

## Entries

### Moderation rule links must use rules hash routes

- **Date:** 2026-06-14
- **Observed by:** Codex
- **Context:** Formatting pending-approval AI moderation reasons that mention community rules.
- **What was surprising:** The 5chan markdown renderer accepts `/rules#an` as an internal React Router link, but treats slash-style rule URLs such as `/rules/an` as unsupported and renders them as plain text.
- **Impact:** Rule references in mod queue reasons can appear unlinked even when the challenge emitted markdown, because the client strips unsupported `/rules/<board>` links.
- **Mitigation:** Generate rules hash-route links for community rule references, for example `[rule #1](/rules#an)`.
- **Status:** confirmed
