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
- **Web search** uses each Model provider's own search, billed on your key by that provider: Anthropic, OpenAI, Google and OpenRouter. Each reply makes at most 5 searches. Anthropic's must be switched on for your organisation in the Claude Console. xAI and local model servers don't search here.
- **Deep research** is web search in rounds: up to 24 model calls and 20 minutes for one report, so it costs more than a message. Between searches the Bot reads pages in full, fetched from your server, and only pages its searches found, links on pages it read, or addresses in the message.
- **Attachments** (images, PDFs and text files people send with a message) are kept in your database with their message.
- **Pictures** Bots make use OpenAI's image model (GPT Image 2.6 Flare) when `OPENAI_API_KEY` is set, else Google's (Nano Banana 2.1) with `GEMINI_API_KEY`, billed on your key whatever the Bot's chat model. A message makes at most four. They're kept in your database with the reply, like Attachments.

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

## Computers

A Computer is a Linux desktop with Firefox that one Bot has. The Bot uses it through its Driver model, an OpenAI, Anthropic or Google model you pick on the Bot's page; ask it to do something that needs a browser and it hands the task to the Driver model, which works on the screen and reports back. You watch it live from the Bot's page and can take over the mouse and keyboard at any time: the Bot waits until you hand back. It is told to stop and ask before paying, sending or deleting, on a best-effort basis.

1. Make up a key and add it to `.env`. It is a password the Bot service and the Computer service share, so nobody issues it: any random string of 32 characters or more. To make one, run `openssl rand -base64 32`, or `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` where there's no `openssl`.

   ```sh
   COMPUTER_SERVICE_API_KEY=
   ```

2. Start Kovobot with Computers:

   ```sh
   docker compose --profile computers up -d
   ```

   The first start builds the desktop image, about 1.4 GB, which takes a few minutes.
3. Open a Bot, choose **Create a Computer**, pick the model it uses the Computer with, then **Watch live**.

- **Each Computer is a container on this machine,** at the size you pick when you create it: Small, Medium, Large or XL. Only the sizes this machine's Docker can give are offered, and you can change a Computer's size while it runs.
- **Asleep and Shut down.** A Computer with no one watching and no Bot at work goes Asleep after 15 minutes; you can pick up to 4 hours on the Bot's page. Asleep keeps its memory and uses no CPU, and Start wakes it. After 30 days Asleep it is Shut down, which keeps its files. Deleting it, or its Bot, deletes them.
- **What a Computer can reach.** Public internet addresses only: not your network or any other private address, so not Postgres or anything else this machine keeps to itself, and not mail servers on port 25. It can send up to 50 Mbit/s and open 20 new connections a second; `COMPUTER_OUTBOUND_MBIT` and `COMPUTER_NEW_CONNECTIONS_PER_SECOND` in `.env` change that.
- **Docker access.** The Computer service drives Docker through its socket, which gives it full control of Docker on this machine. Run it only where you'd run Docker yourself.
- **Its licence.** The Computer service (`apps/computers`) carries the [Functional Source License](apps/computers/LICENSE.md): run it for yourself or your organisation, but not as a service that competes with Kovobot. Each version becomes Apache-2.0 two years after its release.

## Local MCP servers

Bots can use MCP servers on the web, and also programs on this machine that you list. Put them in `.env` as one line of JSON, by name, in Claude Desktop's `mcpServers` form or the map inside it:

```sh
MCP_LOCAL_SERVERS={"time": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-time"]}}
```

Restart, and each Bot's Tools tab offers them to add. Only what you list runs: nobody can type a command in. Each starts for the call that needs it, with only a few safe variables (such as `PATH` and `HOME`) plus its own `env`, never Kovobot's settings or keys. In Docker, the program must be in the image; `npx` and `node` are.

## Keep it running

- **Update.** Run `git pull && docker compose up -d --build`, adding `--profile computers` if you use Computers. Database migrations run each time Kovobot starts.
- **Back up.** Bots and conversations are in Postgres. Save a copy with:

  ```sh
  docker compose exec postgres pg_dump -U kovobot kovobot > kovobot-backup.sql
  ```

- **Restarts.** Both containers start again after a reboot, unless you stopped them with `docker compose stop` or `down`.
- **Schedules** run while Kovobot runs. One that came due while it was stopped runs once when it starts again, not once for every time it missed. Their times follow the time zone of the browser that set them.
- **Logs.** Run `docker compose logs -f kovobot`. Warnings at start-up name any setting that needs fixing.

## What's not here yet

Self-hosted Kovobot does what the hosted service does today: Bots with their own instructions, Skills, notes, schedules, MCP servers, Connected apps (with your own Composio key) and Approvals, models and web chat, plus Linux Computers that Bots drive and you watch and take over. Telegram, Discord and Slack are on the [roadmap](README.md#roadmap).
