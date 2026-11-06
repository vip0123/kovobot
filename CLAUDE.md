# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Node 24, pnpm 10 (`corepack enable`), and Docker for the local Postgres.

```sh
pnpm install
pnpm db:up                 # Postgres on localhost:54329; tests need it running
pnpm db:migrate
pnpm dev                   # API on 3000, web app on 5173 (it forwards /api to the API)
pnpm --filter @kovobot/landing dev        # the landing page on 5174 (a static site on GitHub Pages)
pnpm customers:add someone@example.com    # let a tester in while sign-up is closed
pnpm leads:list            # the waitlist as CSV; pnpm leads:announce emails it once at launch,
                           # run with the live server's environment once SIGN_UP_OPEN=true is deployed
pnpm test                  # every test, each run in a fresh migrated database
pnpm test apps/api/test/sign-in.test.ts   # one file
pnpm test -t "works only once"            # tests whose name matches
pnpm typecheck && pnpm lint && pnpm build
docker build -t kovobot .  # the deployable image; deploy/staging.sh puts it on Cloud Run
```

With no `.env` the server starts self-hosted and writes sign-in links to its log.

## Code rules

- **Node runs the server's `.ts` files directly** by stripping types: no build step, so only erasable syntax (no enums, namespaces or constructor parameter properties) and relative imports end in `.ts`.
- **The server's settings come only from `loadConfig`** in `packages/config`. A new server environment variable goes there, with a test, and into `.env.example`. Tooling reads its own: Vite's proxy reads `API_URL`, and tests read `TEST_DATABASE_URL`.
- **Migrations** live in `packages/db/migrations/NNNN_name.sql`. Each runs before its release ships, while the previous release still serves, so it must work with the previous release's code: add now, drop in a later release. An applied migration is never edited (the migrator checks checksums); write a new one.
- **Tests sit at four seams:** `loadConfig`, the HTTP API through `apps/api/test/harness.ts` against the real database, the functions the CLI commands call (such as `announceSignUpOpen`, through the harness's `deps`), and booting the server. Only the edges are fake: email, Google, the clock, and Model providers, which are local HTTP servers the real SDKs talk to (`apps/api/test/fake-openai.ts`). The web pages are checked by hand in a browser.
- **Model providers plug in behind one seam**, `ModelAdapter` in `apps/api/src/models/adapter.ts` (ADR 0005). SDK retries stay off: one HTTP attempt per call (ADR 0004).
- **The web app calls the API on its own origin under `/api`.** Deployed, the API serves the web build, so the session cookie stays first-party. The landing page is the one cross-origin caller, and only of `POST /api/leads`.
- **Prices and Plan limits come from `@kovobot/plans`**, the Plans-and-prices constant. Never hand-type a price in copy.

## Product

Kovobot is a hosted AI bot service. "Kovobot" is a working name until trademark clearance; the codename is dot-grok-bot.

- **Customers and billing.** Customers sign up on our website and pay us through a Subscription or Pay-as-you-go.
- **What Bots do.** Bots chat on Channels, call models from OpenAI, Anthropic, Google, xAI and OpenRouter, use MCP tools and Composio's Connected apps, keep memory and run schedules. They also drive cloud Computers running Linux, Windows or macOS.
- **Self-hosted mode.** The same code runs self-hosted on the operator's own keys, with billing off.

## Where the design lives

- `GLOSSARY.md`: the domain language. Use its terms in code, docs and UI copy, avoid the synonyms it lists, and add a term when one is settled.
- `docs/design.md`: the settled design and its launch numbers. That covers Plans, Credit rules, prices, Computers, Channels, approvals, trust and safety, and launch blockers. Read the matching section before building any part.
- `docs/adr/`: why each hard-to-reverse decision was made. Write a new ADR before reversing one.
- `docs/research/`: the evidence, private and not in this repo (listed below).

## Clean-room rule

The product is written from scratch. We studied two other products; the private research notes name them and hold our design notes on both.

The rules:

- Learn from the prose design notes. Write code from those notes, from the Model providers' own docs and from `docs/design.md`.
- Never copy, transcribe or closely paraphrase the studied products' code, prompts, tests, schema text or UI copy.
- Never open their source in a task that writes our code.
- Before launch, run a code-similarity scan against both.
- Never describe the product as based on, forked from or derived from another project, in any file, commit message or copy.

## Research notes (private)

`docs/research/` is kept out of this public repo (git-ignored) and belongs in a private one. Its memos:

- `2026-11-04-models-hosting-channels.md`: Model provider APIs, computer-use tools and prices; cloud desktop costs; Windows and Apple licensing; Telegram and Discord payment rules; the name check. Read it before working on model adapters, pricing, the Computer service or Channels.
- The design notes on the two studied products, read under the clean-room rule above.
- `2026-10-15-openai-grok-bots-and-oss-alternative.md`: OpenAI Dots, Grok Bot and the open-source landscape. §9.3 covers payment rails; §10 lists unverified claims.
- `2026-10-15-monetisation-brainstorms.md`: three LLM brainstorms pasted raw. Treat them as hypotheses.

Prices, plans and spec details are snapshots from each memo's access date. Re-check the cited source before relying on a number.

## Hard constraints

- **Provider terms** forbid reselling API access or keys.
  - Hosted AI use runs on our keys, inside our product.
  - Own keys are allowed.
  - Sign-in with ChatGPT or Claude subscriptions is not offered.
- **Telegram and Discord.** Telegram allows digital goods to be sold only through Stars. Discord requires the same prices in its Premium Apps store. So each Customer connects its own Channel app (ADR 0007), and Bots never post a price or billing link in a Channel.
- **Windows.** Microsoft requires a licence per user for any remote desktop use beyond two administrators, including VNC and automation. Google sells no such licences, so Windows Computers can't run on Google Cloud (ADR 0006).
- **Apple.** A Mac may be leased only for developer services (building, testing, developer tools). The lease must last at least 24 hours, go to one Customer, and be notified to Apple in advance. iOS can't run in a VM. Xcode may not be hosted for others, so each Customer installs it under their own Apple Account.
- **EU consumer law** (Consumer Rights Directive Art. 22): Auto top-up stays an unticked opt-in (ADR 0002).
- **App stores** require in-app purchase for digital unlocks, and Apple requires moderation for chatbots. So the mobile apps stay off in the hosted service.

## Writing research docs

Match the existing memos:

- File names follow `YYYY-MM-DD-<slug>.md`.
- Put primary sources first and label secondary ones.
- Use numbered `[n]` citations with access dates, and pin a repo source to a commit.
- Collect unverified claims in an open-questions section.
