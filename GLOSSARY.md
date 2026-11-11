# Kovobot

Kovobot is a hosted AI bot service. Customers sign up on our website and pay us through a Subscription or Pay-as-you-go. Their Bots use many Model providers, talk on Channels and drive cloud Computers.

## Language

### People

**Customer**:
A person or organisation that signs up on our website, owns Bots and pays us.
_Avoid_: user, account, tenant, operator

**Operator**:
Whoever runs a self-hosted install of Kovobot, on their own keys and with billing off.
_Avoid_: admin, host, self-hoster

**Suspension**:
Our stop on a Customer's use after a policy breach. Their Bots stop, and their data is kept for 30 days.
_Avoid_: ban, block, lockout

**Sign-in link**:
A one-time link we email to sign someone in. It works once, for 15 minutes, and the first one used creates the Customer.
_Avoid_: magic link, login link, token

**Lead**:
Someone on the waitlist before sign-up opens: an email, what they'd hand a Bot first, and when they joined. Each Lead gets one email, when sign-up opens.
_Avoid_: subscriber, prospect, signup

### Billing

**Plan**:
The set of limits a Customer has: Free, Pro or Max. It is the highest Plan the Customer's Lifetime paid unlocks.
_Avoid_: tier, package, level

**Billing mode**:
How a paying Customer pays us: Subscription or Pay-as-you-go. The Customer's first payment sets it.
_Avoid_: payment type, pricing model

**Subscription**:
The Billing mode in which the Customer makes a monthly Subscription payment for Pro or Max and gets Plan credit each paid month.
_Avoid_: membership

**Pay-as-you-go**:
The Billing mode with no monthly fee. The Customer buys Top-ups.
_Avoid_: metered plan, usage-based plan, prepaid plan

**Lifetime paid**:
The total a Customer has ever paid us, less refunds and chargebacks. Spending Credit never lowers it.
_Avoid_: total spend, LTV

**Credit**:
Prepaid money a Customer holds with us, spent on AI use and Computer time.
_Avoid_: tokens, coins, points, wallet

**Spendable credit**:
The Credit a Customer can spend right now: all unexpired Credit, Plan credit included, minus any Holds.
_Avoid_: available balance, free balance

**Plan credit**:
Credit that a Subscription grants each paid month. It expires when that paid month ends.
_Avoid_: allowance, quota

**Top-up**:
A one-off purchase of Credit.
_Avoid_: reload, recharge, refill, deposit

**Top-up credit**:
Credit bought with a Top-up. It expires 12 months after purchase.
_Avoid_: prepaid balance

**Auto top-up**:
A Top-up we charge automatically when Credit falls below the Customer's threshold. It only happens if the Customer has switched it on.
_Avoid_: auto-reload, auto-recharge

**Starter credit**:
Credit a new Customer gets once, on Free, after a Starter payment and a verified phone number.
_Avoid_: free credit, trial credit, bonus

**Starter payment**:
The one-time $1 card payment, made through Stripe, that unlocks Starter credit. It is not Credit.
_Avoid_: activation fee, verification fee

**Hold**:
Credit set aside for a model call in progress. It covers the call's input and output cap at the model's rates, and lasts until the call is metered.
_Avoid_: reservation, pre-authorisation, pending charge

**Fee**:
The published percentage we add to a Model provider's cost when AI use is paid from Top-up credit. Plan credit and Starter credit never carry it.
_Avoid_: markup, surcharge, commission

**Price table**:
Our list of Model provider prices. It has one row per model and price class, each with its source and the date it was checked.
_Avoid_: rate card, pricing config

**Computer rate**:
The published price of running a Computer, per hour (per day for a macOS Computer), set above our cloud cost.
_Avoid_: compute fee, markup

**Licence charge**:
The monthly charge from Credit for each Remote Desktop licence a Windows Computer needs: one per Bot that operates it and one per person who watches or takes over.
_Avoid_: RDS fee, SAL fee, seat fee

### Bots and models

**Bot**:
An AI that a Customer sets up and owns. It chats on Channels, calls models and tools, and drives Computers.
_Avoid_: agent, assistant

**Bot instructions**:
What a Customer tells a Bot about how to work for them: who it works for, how it answers, what to always or never do. The Bot gets them with every Task, and they win over our defaults.
_Avoid_: system prompt, persona, custom instructions

**Skill**:
Instructions a Customer writes once for one kind of work, such as a weekly report, and gives to any of their Bots. A Bot sees each of its Skills' names and when to use them, and reads a Skill in full when it applies.
_Avoid_: plugin, prompt, template, GPT

**Note**:
Something a Bot keeps in mind across Conversations, such as a Customer's preference or a decision, in a sentence or two. The Bot writes its own notes as it works; the Customer sees, edits and deletes them. A Bot's notes are its memory.
_Avoid_: memory item, fact, memo

**Bot service**:
Our main service: the website, the API, the agent loop, Channels, model adapters and MCP. It runs every Customer's Bots.
_Avoid_: the Bot (meaning the software), backend, core

**Model provider**:
A company whose models a Bot calls. Direct ones are OpenAI, Anthropic, Google and xAI. OpenRouter routes to many others. A local model server counts too.
_Avoid_: provider (on its own), vendor, LLM backend

**Own key**:
A Customer's own Model provider API key, added to a Bot. Calls on it skip Credit and the Fee.
_Avoid_: BYOK, personal key

**Driver model**:
The model a Bot uses to operate Computers. Only OpenAI, Anthropic and Google models qualify.
_Avoid_: computer-use model

**Task**:
The work a Bot does for one incoming message or one schedule firing, until it replies or stops.
_Avoid_: job, run, turn

**Deep research**:
A Task a message asks for that searches the web and reads pages in full, in rounds, within a set number of model calls and minutes, then writes a report with its sources. The report is the reply, and is also kept as a Markdown file. It only reads.
_Avoid_: research mode, agentic search

**Voice note**:
A message the Customer speaks instead of typing. A speech-to-text model hears it, what it heard is the message, and the recording is kept with it as an Attachment. Any reply can be read aloud.
_Avoid_: audio message, dictation, voice message

**Schedule**:
A task a Bot does on its own at set times: once, every day, on weekdays, on chosen days of the week or once a month, on the clock of a time zone. The Customer sets one on the Bot's page, or asks the Bot to. Each firing is one Task, and its reply goes into the Bot's Conversation.
_Avoid_: cron, job, automation, reminder (for the schedule itself)

### Approvals

**Approval**:
A Customer's OK for one exact action a Bot proposes.
_Avoid_: confirmation, permission, consent

**Pre-approval**:
A Customer's standing OK for one kind of action on one tool. Paying is never pre-approved.
_Avoid_: auto-approve, allowlist, trust

**Linked identity**:
A Customer's own Telegram, Discord or Slack account, linked on our website with a one-time code. Only Linked identities can approve a Bot's actions in a Channel.
_Avoid_: paired user, owner account

**Outside content**:
Anything a Bot reads that the Customer didn't write, such as web pages, emails, other people's files and Channel messages from anyone but the Customer's Linked identities.
_Avoid_: untrusted input, external data

### Channels

**Channel**:
A place where people chat with a Bot: web, the desktop app, Telegram, Discord or Slack.
_Avoid_: integration, platform, connector

**Conversation**:
A Bot's running exchange of messages on one Channel. On the web Channel each Bot has one, and it survives a reload.
_Avoid_: thread, session, chat history

**Attachment**:
A file a Customer sends a Bot with a message: an image, a PDF or a text file. It stays with the message.
_Avoid_: upload, file (on its own)

**Channel app**:
The app a Customer registers with Telegram, Discord or Slack and connects on our website. Their Bot talks on that Channel through it.
_Avoid_: Telegram bot, Discord bot, Slack bot, integration

### Tools

**MCP server**:
A server speaking the Model Context Protocol that a Customer connects to a Bot, signing in to it when it asks, so the Bot can use its tools. What its tools send back is Outside content.
_Avoid_: plugin, connector, integration

**Connected app**:
An outside app, such as an email or calendar service, that a Customer connects through Composio so a Bot can use it as a tool.
_Avoid_: integration, connector, Channel app

### Computers

**Computer**:
A cloud desktop that a Bot drives for its Customer, charged at the Computer rate.
_Avoid_: VM, sandbox, instance, machine

**Computer agent**:
Our own software inside each Computer. It carries out the Driver model's actions and streams the live view.
_Avoid_: in-VM agent, daemon

**Computer size**:
The CPU and memory a Computer gets: Small, Medium, Large or XL.
_Avoid_: instance type, flavour, tier

**macOS Computer**:
A whole Mac leased to one Max Customer for building and testing apps.
_Avoid_: Mac VM, cloud Mac

**Asleep**:
The resting state a Linux or Windows Computer enters after a spell with no activity. Memory and disk are kept. Only storage is charged, plus the Licence charge on Windows. A macOS Computer is never Asleep.
_Avoid_: suspended, hibernated, idle, paused

**Shut down**:
A Computer's state after 30 days Asleep. The disk is kept and memory is dropped.
_Avoid_: stopped, powered off

**Computer service**:
Our separate service that creates, runs and bills Computers. The Bot service is its first and only client at launch.
_Avoid_: hosting platform, sandbox API
