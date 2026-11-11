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
| Bots | Create, rename, delete, switch models, with no limit on how many. Give each its own instructions and Skills (write them, or import SKILL.md files). Each keeps notes across Conversations that you can read and edit, does tasks on schedules you or it set, and uses the tools of MCP servers you connect |
| Chat | Streamed replies on the web Channel that survive a reload; attach images, PDFs and text files; see what the model thinks; "think deeper"; web search with sources, and deep research: rounds of searching and reading that end in a cited report, kept as a file too; pictures Bots make with OpenAI's or Google's image model (self-hosted) |
| Model providers | OpenAI, Anthropic (prompt caching, refusal fallbacks), Google Gemini, xAI, OpenRouter, local OpenAI-compatible servers (self-hosted) |
| Computers | Self-hosted: a Linux desktop per Bot in local Docker. The Bot uses it through a Driver model (OpenAI, Anthropic or Google); you watch live and can take over, and the Bot waits |
| Waitlist | Early-access landing page with a waitlist and a one-time launch email |

Coming next: Own keys, Credit and metering, Telegram, Discord and Slack, and cloud Computers. See the [roadmap](#roadmap).

## Self-host in five minutes

You need Git and Docker. Your Model provider keys go in a `.env` file on your own machine; Kovobot reads them when it starts.

```sh
git clone https://github.com/vip0123/kovobot.git
cd kovobot
cp .env.example .env
# Open .env and paste at least one Model provider key, e.g.
#   ANTHROPIC_API_KEY=sk-ant-...   or   OPENROUTER_API_KEY=sk-or-...
docker compose up -d
```

Open http://localhost:8080 and enter your email. Without email settings, the sign-in link goes to the log: `docker compose logs kovobot`. Create a Bot, pick a model, and say hello.

Self-hosted installs never charge: billing and Plan limits stay off. **[SELF-HOSTING.md](SELF-HOSTING.md)** covers each key, local models (Ollama), emailed sign-in links, and running it on a server for other people. To work on the code itself, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Configuration

Every setting is in [`.env.example`](.env.example), with a comment on what it does. The ones that matter first:

| Setting | What it does |
|---|---|
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY` | Each one switches that Model provider on |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | Email sign-in links instead of logging them |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Sign in with Google |
| `SESSION_SECRET` | Keeps people signed in across restarts |
| `KOVOBOT_URL` | The address people open Kovobot at, when it runs on a server |
| `SIGN_UP_OPEN` | `false` lets in only the people you add, so strangers can't spend on your keys |

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
- [x] MCP servers: connect one to a Bot, sign in with OAuth, and its read-only tools run at once
- [x] Approvals on the web: an action that sends, changes, deletes or pays waits for yours, and Pre-approvals cover one kind of action on one tool (never paying)
- [x] Connected apps through Composio: connect accounts on its hosted sign-in, several to an app, and give each to the Bots you choose
- [x] Memory: notes each Bot keeps, which you read and edit
- [x] Schedules: once, daily, weekdays, weekly or monthly, in your time zone
- [x] Linux Computers in local Docker, watched live (self-hosted)
- [x] Bots drive their Computers through a Driver model, and wait while you take over
- [ ] Cloud Computers: Linux, Windows and macOS

## Contributing

Issues, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md): it covers setup, tests and how a change gets merged. If you're not sure where to begin, open an issue describing what you'd like your Bot to do; that shapes the roadmap.

**Fork it, build a Bot, tell us what it should do next.** And if Kovobot is useful to you, a ⭐ helps others find it.

## License

Kovobot is open source under [Apache-2.0](LICENSE), except the Computer service in `apps/computers`, which carries the Functional Source License, [FSL-1.1-ALv2](apps/computers/LICENSE.md). FSL allows any use except offering a competing product, so you can self-host it, and each version becomes Apache-2.0 two years after its release. Billing will carry FSL too once it's built. "Kovobot" is a working name.
