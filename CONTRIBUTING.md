# Contributing to Kovobot

Thanks for helping. This guide gets you from a fresh clone to a merged pull request.

## Set up

You need Node 24, pnpm 10 (`corepack enable`) and Docker.

```sh
pnpm install
pnpm db:up && pnpm db:migrate
cp .env.example .env   # then add at least one Model provider key
pnpm dev               # web app on http://localhost:5173, API on :3000
```

Without SMTP settings, sign-in links go to the API's log. `docker compose up -d` runs the built image instead, as an Operator would ([SELF-HOSTING.md](SELF-HOSTING.md)).

## Before you open a pull request

```sh
pnpm test        # every test, against a real Postgres (pnpm db:up first)
pnpm typecheck
pnpm lint
pnpm build
```

Run one file with `pnpm test apps/api/test/bots.test.ts`, or tests by name with `pnpm test -t "streams"`.

## How we write code

- **Tests first, at the public seams:** the config loaders, the HTTP API (against a real database), each Model provider adapter (against a local fake of its API), and the Computer service's API (against real Docker). Fake only what lies outside the code under test: email, Google sign-in, the clock, Model providers, and the Computer service when testing the Bot service.
- **One vocabulary.** Use the terms in [GLOSSARY.md](GLOSSARY.md) in code, docs and UI copy, and avoid the synonyms it lists: a *Customer*, never a "user"; a *Bot*, never an "agent".
- **Settings come only from `loadConfig`** in `packages/config` (the Computer service's from `loadComputerServiceConfig`, and the Computer agent's from the Computer service when it creates the Computer); add a test and a line in `.env.example` for each new one.
- **Migrations only add.** Each runs while the previous release still serves, so it must work with that release's code. Never edit one that has shipped.
- **Prices and Plan limits come from `@kovobot/plans`**, never from hand-typed copy.
- **Written from scratch.** Don't copy code, prompts, tests or UI text from other projects.

[CLAUDE.md](CLAUDE.md) has the full set of rules, which both people and coding agents follow.

## Pull requests

1. Open an issue first for anything larger than a small fix, so we can agree on the shape.
2. Keep each pull request to one change, with tests.
3. Describe what changed and how you checked it.

Before your first pull request is merged, you'll be asked to sign our Contributor License Agreement, which lets us keep the open-source and source-available parts of Kovobot side by side.

## Questions

Open an issue. Ideas for what a Bot should do next are especially welcome.
