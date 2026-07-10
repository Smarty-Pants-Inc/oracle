---
title: Followups & Lineage
description: "Continue an OpenAI / Azure Responses API run with new files. Multi-model parents pick lineage via --followup-model."
---

`--followup` chains a new run onto an existing OpenAI or Azure Responses API session. The model keeps its prior reasoning context; you supply additional prompt + files. Lineage is tracked in `oracle status` so you can see the whole tree at a glance.

## Why followup instead of starting fresh

- **Cheaper.** You don't re-pay for the original input tokens.
- **Coherent.** The model remembers its earlier conclusions and can reason about _changes_.
- **Auditable.** `oracle status` shows the parent/child tree.

## Basic flow

```bash
# Initial run
oracle --model gpt-5.6-sol-pro --slug arch-review \
  -p "Audit the auth flow end-to-end" \
  --file "src/auth/**"

# Later — continue with new files
oracle --followup arch-review \
  -p "Re-evaluate now that the rate-limiter is wired in." \
  --file "src/auth/rate-limiter.ts"
```

`--followup` accepts:

- A stored session id (`a1b2c3…`)
- A session slug (`arch-review`)
- An OpenAI / Azure response id (`resp_abc1234…`) — useful for chaining onto runs that didn't originate in Oracle.

## Multi-model parents

When the parent used `--models a,b,c`, pick which lineage to continue from with `--followup-model`:

```bash
oracle --followup arch-review --followup-model gpt-5.6-sol-pro \
  -p "Continue from the Pro answer" \
  --file "src/auth/rate-limiter.ts"
```

Without `--followup-model`, Oracle errors with the available lineage.

## What's chainable

| Provider                 | Followup support                                        |
| ------------------------ | ------------------------------------------------------- |
| OpenAI Responses API     | ✅ via `previous_response_id`                           |
| Azure OpenAI (Responses) | ✅ via `previous_response_id`                           |
| Anthropic                | ❌ no Oracle-side response id chaining yet              |
| Gemini                   | ❌                                                      |
| OpenRouter               | ❌                                                      |
| Custom `--base-url`      | ❌ — unknown whether the upstream preserves the id      |
| Browser mode (ChatGPT)   | partial — see [Browser multi-turn](#browser-multi-turn) |

If you try to follow up on an unsupported provider, Oracle errors clearly instead of silently starting fresh.

## Browser multi-turn

In browser mode, `--browser-follow-up` adds extra prompts to the _same ChatGPT conversation_, which is the closest equivalent to a chained API followup:

```bash
oracle --engine browser --model gpt-5.6-sol-pro \
  -p "Review this migration plan" --file docs/migration.md \
  --browser-follow-up "Challenge your previous recommendation" \
  --browser-follow-up "Give the final decision"
```

Each `--browser-follow-up` is sent after the previous turn completes. Not supported in Deep Research mode.

## Lineage in `oracle status`

```
Status    Model         Mode    Timestamp           Chars    Cost  Slug
completed gpt-5.6-sol-pro api     05/06 09:00 AM      1800  $2.110  arch-review
completed gpt-5.6-sol-pro api     05/06 09:14 AM      2200  $2.980  ├─ arch-review-rate-limiter
running   gpt-5.6-sol-pro api     05/06 09:22 AM      1400       -  │  └─ arch-review-implementation
pending   gpt-5.6-sol-pro api     05/06 09:25 AM       900       -  └─ arch-review-risk-check
```

Children inherit the parent's slug prefix unless you pass `--slug` explicitly.

## Common patterns

- **Plan → challenge → final.** Three turns: ask Pro to plan, follow up with "find the weakest assumption," follow up again with "given the above, give the final plan."
- **Bug → repro → fix.** Turn 1 sends the failing test + error. Turn 2 sends the suspected file. Turn 3 sends the proposed fix and asks for review.
- **Architecture → implementation.** Parent run does design; children focus on individual modules. The tree in `oracle status` becomes the audit trail.

## Limitations

- Followups don't move between providers. You can't follow up an OpenAI run with a Gemini one — open a new session and re-bundle.
- `previous_response_id` retention on OpenAI / Azure varies by tier. If a followup fails with "response not found," the parent has aged out — start fresh.
- Custom `--base-url` proxies (LiteLLM, etc.) often strip the response id. Test once before relying on it.
