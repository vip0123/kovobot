<div align="center">

# Kovobot

**The AI Bot that gets things done.**

Kovobot chats on the Channels you already use, works on its own cloud Computer, remembers what matters and runs on a schedule. It checks with you before it sends, changes, deletes or pays.

[**Join the early-access list →**](https://kovobot.com) · [Self-host it](#self-host-in-five-minutes) · [Contribute](CONTRIBUTING.md)

⭐ **Star this repo** to follow along: every merged ticket brings a Bot closer to doing real work for you.

</div>

---

## Why Kovobot

- **Any model, your choice per Bot.** OpenAI, Anthropic, Google, xAI, and hundreds more through OpenRouter. Switch a Bot's model at any time; its conversation stays.
- **Talks where you do.** Web today; Telegram, Discord, Slack and a desktop app are on the way, each through an app you own.
- **Asks before it acts.** Reads run at once; sending, changing, deleting and paying wait for your Approval.
- **Open source, self-hostable.** Run the Bot service on your own Model provider keys with billing switched off.

## What works today

| | |
|---|---|
| Sign in | One-time email link or Sign in with Google; no passwords stored |
| Bots | Create, rename, delete, switch models; no limit on how many |
| Chat | Streamed replies on the web Channel; conversations survive a reload |
| Model providers | OpenAI, Anthropic (prompt caching, refusal fallbacks), Google Gemini, xAI, OpenRouter, local OpenAI-compatible servers (self-hosted) |
| Waitlist | Early-access landing page with a waitlist and a one-time launch email |

Coming next: Own keys, Credit and metering, Telegram, Discord and Slack, MCP tools, memory, schedules, and cloud Computers. See the [roadmap](#roadmap).

## Self-host in five minutes

You need Node 24, pnpm 10 (`corepack enable`) and Docker.

```sh
git clone https://github.com/vip0123/kovobot.git
cd kovobot
pnpm install
pnpm db:up          # Postgres on localhost:54329
pnpm db:migrate
cp .env.example .env
# Put at least one Model provider key in .env, e.g. ANTHROPIC_API_KEY=…
pnpm dev            # web app on http://localhost:5173, API on :3000
```

Open http://localhost:5173, enter your email, and copy the sign-in link from the API's log (without SMTP settings, links go to the log). Create a Bot, pick a model, and say hello.

Self-hosted installs never charge: billing and Plan limits stay off. To use a local model server (Ollama, vLLM), set `OPENAI_COMPATIBLE_BASE_URL`, e.g. `http://localhost:11434/v1`.

## Configuration

Every setting is in [`.env.example`](.env.example), with a comment on what it does. The ones that matter first:

| Setting | What it does |
|---|---|
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY` | Each one switches that Model provider on |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | Email sign-in links instead of logging them |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Sign in with Google |
| `SESSION_SECRET` | Keeps people signed in across restarts |

## How it's built

```text
apps/
├── api/        Hono API on Node 24; our own agent loop; one adapter per Model provider
├── web/        React + Vite web app, served by the API on one origin
└── landing/    the early-access page (kovobot.com, GitHub Pages)
packages/
├── config/     every setting, checked at start-up
├── db/         Postgres and its SQL migrations
└── plans/      Plans and prices, one source for every page
```

TypeScript end to end, Postgres as the only database, and tests that run against a real database with local fakes of each Model provider's API. The [design](GLOSSARY.md) uses one vocabulary everywhere: Bot, Customer, Channel, Credit, Computer.

## Roadmap

- [x] Sign-in, Bots and streamed chat on the web
- [x] Every major Model provider, switchable per Bot
- [x] Early-access landing page and waitlist
- [ ] Own keys per Bot
- [ ] Credit, metering and Plans (hosted)
- [ ] Telegram, Discord and Slack
- [ ] MCP tools and Connected apps, with Approvals
- [ ] Memory and schedules
- [ ] Cloud Computers: Linux, Windows and macOS

## Contributing

Issues, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md): it covers setup, tests and how a change gets merged. If you're not sure where to begin, open an issue describing what you'd like your Bot to do; that shapes the roadmap.

**Fork it, build a Bot, tell us what it should do next.** And if Kovobot is useful to you, a ⭐ helps others find it.

## License

The Bot service is open source under Apache-2.0. Billing and the Computer service will carry the Functional Source License (FSL-1.1-ALv2). "Kovobot" is a working name.
