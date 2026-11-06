# Contributing to Kovobot

Thanks for helping. This guide gets you from a fresh clone to a merged pull request.

## Set up

You need Node 24, pnpm 10 (`corepack enable`) and Docker.

```sh
pnpm install
pnpm db:up && pnpm db:migrate
pnpm dev
```

## Before you open a pull request

```sh
pnpm test        # every test, against a real Postgres (pnpm db:up first)
pnpm typecheck
pnpm lint
pnpm build
```

Run one file with `pnpm test apps/api/test/bots.test.ts`, or tests by name with `pnpm test -t "streams"`.

## How we write code

- **Tests first, at the public seams:** the config loader, the HTTP API (against a real database), and each Model provider adapter (against a local fake of its API). Fake only what lies outside our code: email, Google sign-in, the clock and Model providers.
- **One vocabulary.** Use the terms in [GLOSSARY.md](GLOSSARY.md) in code, docs and UI copy, and avoid the synonyms it lists: a *Customer*, never a "user"; a *Bot*, never an "agent".
- **Settings come only from `loadConfig`** in `packages/config`; add a test and a line in `.env.example` for each new one.
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
