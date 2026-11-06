# Self-hosting Kovobot

Run your own Kovobot on your own Model provider keys. A self-hosted install never charges: there are no Plans or Credit, and billing, Plan limits and analytics are off.

Your keys live in one file, `.env`, on the machine that runs Kovobot. They're never sent anywhere except to the Model provider each one belongs to.

## Start it on your computer

You need Git and Docker.

```sh
git clone https://github.com/vip0123/kovobot.git
cd kovobot
cp .env.example .env
```

Open `.env` in any editor and paste at least one Model provider key after its `=`:

```sh
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-...
```

Then start it:

```sh
docker compose up -d
```

Open http://localhost:8080 and enter your email. With no email settings, the sign-in link is written to the log instead of sent:

```sh
docker compose logs kovobot
```

Open the link, create a Bot, pick a model and say hello. Only models whose key you set can be picked.

## Your Model provider keys

Each key you set switches that Model provider's models on, for every Bot on your install. Leave a key blank to switch its provider off.

| Setting | Model provider | Where to get a key |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | Claude Console, API keys. Create the key inside a workspace. |
| `OPENAI_API_KEY` | OpenAI (GPT) | https://platform.openai.com/api-keys |
| `GEMINI_API_KEY` | Google (Gemini) | https://aistudio.google.com/apikey |
| `XAI_API_KEY` | xAI (Grok) | https://console.x.ai |
| `OPENROUTER_API_KEY` | OpenRouter: hundreds of models from many providers, on one key | https://openrouter.ai/keys |
| `OPENAI_COMPATIBLE_BASE_URL` | A model server on your own machine, such as Ollama or vLLM | Ollama: `http://host.docker.internal:11434/v1` |

- **Changing a key.** After you change `.env`, run `docker compose up -d` again to restart Kovobot with the new settings.
- **Local model servers.** Inside the container, `localhost` is the container itself, so reach a server on your machine as `host.docker.internal`.
- **A `$` in a value.** Wrap that value in single quotes, because Docker Compose reads `$` as the start of a variable.

Every other setting is in [`.env.example`](.env.example), with a comment on what it does.

## Put it on a server

To let other people use your Bots, run Kovobot on a server with a domain name, such as `bots.example.com`.

1. Install Git and Docker on the server, then clone and set up `.env` as above.
2. Add these settings to `.env`:

   ```sh
   # The address people open Kovobot at
   KOVOBOT_URL=https://bots.example.com
   # Keeps people signed in across restarts: openssl rand -base64 32
   SESSION_SECRET=
   # Only the people you let in can sign in
   SIGN_UP_OPEN=false
   # Sign-in links by email; any SMTP service works
   SMTP_HOST=
   SMTP_PORT=587
   SMTP_USER=
   SMTP_PASSWORD=
   EMAIL_FROM="Kovobot <noreply@example.com>"
   ```

3. Start Kovobot with `docker compose up -d`.
4. Put HTTPS in front of it. Kovobot listens only on the server itself (port 8080), so a reverse proxy has to serve it to the internet. With [Caddy](https://caddyserver.com), which gets the certificate itself, one command does it:

   ```sh
   caddy reverse-proxy --from bots.example.com --to localhost:8080
   ```

5. Let each person in by email, yourself first:

   ```sh
   docker compose exec kovobot node apps/api/src/cli/customers-add.ts you@example.com
   ```

Keep `SIGN_UP_OPEN=false` on a server. Otherwise anyone who finds your address can sign up and spend on your keys.

**Sign in with Google.** Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. The redirect URI to register with Google is your `KOVOBOT_URL` followed by `/api/auth/google/callback`.

## Keep it running

- **Update.** Run `git pull && docker compose up -d --build`. Database migrations run each time Kovobot starts.
- **Back up.** Bots and conversations are in Postgres. Save a copy with:

  ```sh
  docker compose exec postgres pg_dump -U kovobot kovobot > kovobot-backup.sql
  ```

- **Restarts.** Both containers start again after a reboot, unless you stopped them with `docker compose stop` or `down`.
- **Logs.** Run `docker compose logs -f kovobot`. Warnings at start-up name any setting that needs fixing.

## What's not here yet

Self-hosted Kovobot does what the hosted service does today: Bots, models and web chat. Telegram, Discord and Slack, MCP tools, memory, schedules and Computers (Linux, in local Docker) are on the [roadmap](README.md#roadmap).
