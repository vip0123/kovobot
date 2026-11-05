import { useState, type ReactNode } from "react";
import {
  ASLEEP_AFTER_MINUTES,
  COMPUTER_SIZES,
  computerSize,
  FEE_PERCENT,
  formatCents,
  LINUX_CENTS_PER_HOUR,
  MACOS_COMPUTER,
  type Plan,
  PLANS,
  STARTER_CREDIT,
  TOP_UP,
  WINDOWS_COMPUTER,
} from "@kovobot/plans";
import { FIRST_USES, useWaitlist } from "./waitlist.ts";

type Waitlist = ReturnType<typeof useWaitlist>;
type BillingMode = "subscription" | "pay-as-you-go";

const STARTER_LINE = `${formatCents(STARTER_CREDIT.creditCents)} of Starter credit, once, for a ${formatCents(
  STARTER_CREDIT.starterPaymentCents,
)} card payment and a verified phone number.`;

export function Landing() {
  const waitlist = useWaitlist();
  return (
    <>
      <Header />
      <main id="top">
        <Hero waitlist={waitlist} />
        <Channels />
        <Jobs />
        <Steps />
        <Approvals />
        <Computers />
        <Pricing />
        <SelfHost />
        <Faq />
        <GetAccess waitlist={waitlist} />
      </main>
      <Footer />
    </>
  );
}

function Header() {
  return (
    <header className="site-header">
      <div className="container header-inner">
        <a href="#top" className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 4v16M17 4l-8 8 8 8" />
            </svg>
          </span>
          <span className="brand-name">Kovobot</span>
        </a>
        <nav aria-label="Main" className="main-nav">
          <a href="#jobs">What it does</a>
          <a href="#computers">Computers</a>
          <a href="#pricing">Pricing</a>
          <a href="#self-host">Self-host</a>
          <a href="#faq">FAQ</a>
          <a href="#get-access" className="button button-primary button-small">
            Get early access
          </a>
        </nav>
      </div>
    </header>
  );
}

function Hero({ waitlist }: { waitlist: Waitlist }) {
  const error = waitlist.errorFor("hero");
  return (
    <section className="hero">
      <div className="container hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">Hosted AI Bots · Early access</p>
          <h1>The AI Bot that gets things done.</h1>
          <p className="lede">
            Kovobot chats on the Channels you already use, works on its own cloud Computer, remembers what matters and
            runs on a schedule. It checks with you before it sends, changes, deletes or pays.
          </p>
          {waitlist.joined ? (
            <Joined email={waitlist.email} />
          ) : (
            <form className="hero-form" noValidate onSubmit={(event) => waitlist.join(event, "hero")}>
              <label htmlFor="hero-email" className="field-label">
                Email
              </label>
              <div className="field-row">
                <input
                  id="hero-email"
                  className="input"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  value={waitlist.email}
                  onChange={(event) => waitlist.setEmail(event.target.value)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "hero-error" : undefined}
                />
                <button type="submit" className="button button-primary button-large" disabled={waitlist.sending}>
                  Get early access
                </button>
              </div>
              {error && (
                <p id="hero-error" role="alert" className="form-error">
                  {error}
                </p>
              )}
              <p className="form-note">The Free Plan comes with {STARTER_LINE}</p>
            </form>
          )}
          <p className="mono-line">Models from OpenAI · Anthropic · Google · xAI · OpenRouter</p>
        </div>
        <HeroDemo />
      </div>
    </section>
  );
}

function Joined({ email, large = false }: { email: string; large?: boolean }) {
  return (
    <div role="status" className={large ? "joined joined-large" : "joined"}>
      <svg width={large ? 32 : 24} height={large ? 32 : 24} viewBox="0 0 24 24" fill="none" stroke="#0F7A43" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12.5l2.8 2.8L16.5 9" />
      </svg>
      <div>
        <p className="joined-title">You're on the list.</p>
        <p className="muted">We'll email {email.trim()} as soon as sign-up opens.</p>
      </div>
    </div>
  );
}

function HeroDemo() {
  const small = computerSize("small");
  return (
    <div className="hero-demo" aria-label="An example of a Bot at work" role="img">
      <div className="chat-card">
        <div className="chat-head">
          <span className="chat-channel"># growth</span>
          <span className="mono-small muted">Slack · your Channel app</span>
        </div>
        <div className="bubble-out">
          Every Monday at 9, check our three competitors' pricing pages and post what changed here.
        </div>
        <div className="bubble-in-row">
          <span className="avatar" aria-hidden="true">
            K
          </span>
          <div className="bubble-in">
            Scheduled for Mondays at 9:00. This week's check is done, and the summary is ready to post.
          </div>
        </div>
        <div className="approval-card">
          <div className="approval-head">
            <span className="badge badge-warning">NEEDS YOUR APPROVAL</span>
            <span className="muted small">Post a message to # growth</span>
          </div>
          <p className="small-body">
            Pricing watch, week 45: one competitor raised its team price and another added a free trial. Links and
            screenshots are in the thread.
          </p>
          <div className="approval-actions" aria-hidden="true">
            <span className="button button-primary button-small">Approve</span>
            <span className="button button-outline button-small">Edit</span>
            <span className="button button-quiet button-small">Decline</span>
          </div>
        </div>
      </div>
      <div className="mini-cards">
        <div className="mini-card mini-computer">
          <div className="mini-head">
            <span className="mini-title">Computer · Linux {small.name}</span>
            <span className="badge badge-success">RUNNING</span>
          </div>
          <div className="screen" aria-hidden="true">
            <div className="screen-dots">
              <span />
              <span />
              <span />
            </div>
            <div className="screen-bar" />
            <div className="screen-panes">
              <div />
              <div className="screen-pane-active" />
              <div />
            </div>
          </div>
          <span className="link-accent">Watch live or take over</span>
        </div>
        <div className="mini-card">
          <span className="mini-title">Schedule</span>
          <span className="mini-big">Mondays, 9:00</span>
          <span className="muted small">Next check in 6 days. Notes from last week are kept in memory.</span>
        </div>
      </div>
    </div>
  );
}

function Channels() {
  return (
    <section aria-label="Channels" className="strip">
      <div className="container strip-inner">
        <p className="eyebrow">Talks where you do</p>
        <ul className="strip-list">
          <li>Web</li>
          <li>Desktop app</li>
          <li>Telegram</li>
          <li>Discord</li>
          <li>Slack</li>
        </ul>
      </div>
    </section>
  );
}

const ICONS: Record<string, ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  code: <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13.5 5l-3 14" />,
};

function Icon({ name, size = 28 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      {ICONS[name]}
    </svg>
  );
}

function Jobs() {
  const max = PLANS.find((plan) => plan.macos)!;
  const jobs = [
    { icon: "search", title: "Market watch", body: "Checks competitors' sites on a schedule, notes price and feature changes, and sends you a Monday summary." },
    { icon: "mail", title: "Inbox follow-ups", body: "Drafts replies and chases the threads that went quiet. Nothing is sent until you approve it." },
    { icon: "chart", title: "Reports from your tools", body: "Pulls numbers from the tools you connect over MCP and posts a short summary to your team's Slack channel." },
    { icon: "code", title: "Build and test apps", body: `On a Mac of its own, your Bot builds your app and runs it in the iOS Simulator. Available on ${max.name}.` },
  ] as const;
  return (
    <section id="jobs" className="section">
      <div className="container stack-40">
        <div className="section-head">
          <h2 className="section-title">Work you can hand to a Bot</h2>
          <p className="section-lede">
            Not a chat window that gives advice. A Bot that opens the pages, fills in the forms, writes the report and
            asks before anything goes out.
          </p>
        </div>
        <div className="card-grid">
          {jobs.map((job) => (
            <article key={job.title} className="card">
              <Icon name={job.icon} />
              <h3>{job.title}</h3>
              <p className="muted">{job.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Steps() {
  const steps = [
    { title: "Create a Bot", body: "Sign up on our website, name your Bot and pick its model. Add your own key if you have one." },
    { title: "Connect your Channels", body: "Register your own Telegram, Discord or Slack app and connect it. Your Bot talks through an app you own." },
    { title: "Hand it some work", body: "Ask in chat or set a schedule. It reads straight away and asks before it acts for you." },
  ];
  return (
    <section aria-labelledby="how-title" className="section section-tight-top">
      <div className="container stack-40">
        <h2 id="how-title" className="section-title">
          Up and running in three steps
        </h2>
        <ol className="steps">
          {steps.map((step, index) => (
            <li key={step.title} className="step">
              <span className="mono-small muted">{String(index + 1).padStart(2, "0")}</span>
              <h3>{step.title}</h3>
              <p className="muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Check() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon check">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

function Approvals() {
  const points = [
    ["Reads run at once.", "Looking things up never waits on you."],
    ["Actions wait for your Approval.", "Sending messages, emails or posts, creating or changing things, deleting and paying."],
    ["Pre-approve the routine.", "Allow one kind of action on one tool. Paying always asks."],
    ["No surprises from strangers.", "Once a Task reads web pages or emails, Pre-approvals are set aside and it asks you again."],
  ];
  const rules = [
    ["Post to Slack", "ALLOWED", "allowed"],
    ["Send email", "ASK ME", "ask"],
    ["Delete files", "ASK ME", "ask"],
    ["Pay for anything", "ALWAYS ASKS", "always"],
  ];
  return (
    <section aria-labelledby="approvals-title" className="section band">
      <div className="container split">
        <div className="split-copy">
          <p className="eyebrow">Approvals</p>
          <h2 id="approvals-title" className="section-title">
            It does the work. You keep the final say.
          </h2>
          <ul className="checklist">
            {points.map(([lead, rest]) => (
              <li key={lead}>
                <Check />
                <span>
                  <strong>{lead}</strong> {rest}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rules-panel">
          <div className="rules-head">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
              <path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" />
              <path d="M8.5 12l2.5 2.5 4.5-5" />
            </svg>
            <span className="rules-title">Pre-approvals for Market watch</span>
          </div>
          <div className="rules">
            {rules.map(([action, label, tone]) => (
              <div key={action} className="rule">
                <span>{action}</span>
                <span className={`rule-state rule-${tone}`}>{label}</span>
              </div>
            ))}
          </div>
          <p className="muted small">An Approval covers the exact action shown. If the content changes, your Bot asks again.</p>
        </div>
      </div>
    </section>
  );
}

function Computers() {
  const windowsSize = computerSize(WINDOWS_COMPUTER.size);
  const windowsPlans = PLANS.filter((plan) => plan.windows).map((plan) => plan.name.toUpperCase());
  const macosPlans = PLANS.filter((plan) => plan.macos).map((plan) => plan.name.toUpperCase());
  return (
    <section id="computers" className="section">
      <div className="container stack-40">
        <div className="section-head wide">
          <h2 className="section-title">A Computer of its own</h2>
          <p className="section-lede">
            Your Bot drives a real cloud desktop. Watch it live in your browser and take over whenever you like. Linux
            and Windows Computers go Asleep after {ASLEEP_AFTER_MINUTES} minutes without activity, so you pay only for
            storage, plus the Licence charge on Windows.
          </p>
        </div>
        <div className="card-grid card-grid-wide">
          <article className="card">
            <div className="card-title-row">
              <h3>Linux</h3>
              <span className="mono-small muted">ALL PLANS</span>
            </div>
            <div className="price-rows">
              {COMPUTER_SIZES.map((size) => (
                <div key={size.size} className="price-row">
                  <span>
                    {size.name} · {size.vcpus} vCPU, {size.memoryGb} GB
                  </span>
                  <strong>{formatCents(LINUX_CENTS_PER_HOUR[size.size])}/h</strong>
                </div>
              ))}
            </div>
            <p className="muted small">Disk is charged per GB-month while the Computer exists.</p>
          </article>
          <article className="card">
            <div className="card-title-row">
              <h3>Windows</h3>
              <span className="mono-small muted">{windowsPlans.join(" AND ")}</span>
            </div>
            <p className="big-price">
              {formatCents(WINDOWS_COMPUTER.centsPerHour)}
              <span> an hour</span>
            </p>
            <p className="muted">
              {windowsSize.name}: {windowsSize.vcpus} vCPU, {windowsSize.memoryGb} GB. Plus a monthly Licence charge
              {WINDOWS_COMPUTER.licenceChargeCentsPerMonth === null
                ? ""
                : ` of ${formatCents(WINDOWS_COMPUTER.licenceChargeCentsPerMonth)}`}{" "}
              for each Bot that uses it and each person who watches or takes over.
            </p>
          </article>
          <article className="card">
            <div className="card-title-row">
              <h3>macOS</h3>
              <span className="mono-small muted">{macosPlans.join(" AND ")}</span>
            </div>
            <p className="big-price">
              {formatCents(MACOS_COMPUTER.centsPerDay)}
              <span> a day</span>
            </p>
            <p className="muted">
              A whole Mac, yours alone for at least a day, for building and testing apps. iOS runs in the Simulator, and
              you install Xcode under your own Apple Account.
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}

/** What a Plan includes, written from its limits. */
function planFeatures(plan: Plan): string[] {
  const features = [plan.bots === null ? "Unlimited Bots" : `Up to ${plan.bots} Bots`];
  const allSizes = plan.computerSizes.length === COMPUTER_SIZES.length;
  const computers = `${plan.linuxComputers} Linux Computer${plan.linuxComputers === 1 ? "" : "s"}`;
  if (plan.linuxHoursPerMonth !== null) features.push(`${computers}, ${plan.linuxHoursPerMonth} hours a month`);
  else features.push(`${computers}, ${allSizes ? "all sizes" : "no hour cap"}`);
  if (!allSizes) {
    const names = plan.computerSizes.map((size) => computerSize(size).name);
    features.push(names.length === 2 ? `${names[0]} and ${names[1]} sizes` : `Sizes up to ${names.at(-1)}`);
  }
  if (plan.windows) features.push("Windows Computers");
  if (plan.macos) features.push("A macOS Computer for building and testing apps");
  return features;
}

function Pricing() {
  const [mode, setMode] = useState<BillingMode>("subscription");
  const subscription = mode === "subscription";
  return (
    <section id="pricing" className="section section-tight-top">
      <div className="container stack-32">
        <div className="pricing-head">
          <div className="section-head">
            <h2 className="section-title">Pricing</h2>
            <p className="section-lede">
              Subscribe for monthly Plan credit, or top up as you go. Plan credit pays model prices at cost. Top-up
              credit adds a {FEE_PERCENT}% Fee on AI use.
            </p>
          </div>
          <div role="group" aria-label="Billing mode" className="toggle">
            <button type="button" aria-pressed={subscription} onClick={() => setMode("subscription")}>
              Subscription
            </button>
            <button type="button" aria-pressed={!subscription} onClick={() => setMode("pay-as-you-go")}>
              Pay-as-you-go
            </button>
          </div>
        </div>
        <div className="card-grid card-grid-plans">
          {PLANS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} subscription={subscription} />
          ))}
        </div>
        <div className="card-grid card-grid-notes">
          <div className="note">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
              <circle cx="8" cy="15" r="4" />
              <path d="M11 12l9-9M17 6l3 3" />
            </svg>
            <p>
              <strong>Own keys welcome.</strong> AI calls on your own key skip Credit and the Fee.
            </p>
          </div>
          {subscription ? (
            <div className="note">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              <p>
                <strong>Cancel any time.</strong> Your Subscription ends when the paid month ends, and unspent Top-up
                credit stays yours.
              </p>
            </div>
          ) : (
            <div className="note">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
                <path d="M12 3v18M17 7.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2.2 2.6 5 3.2 5 1.4 5 3.3-2.2 3.5-5 3.5-5-1.4-5-3.3" />
              </svg>
              <p>
                <strong>
                  Top up {formatCents(TOP_UP.minCents)} to {formatCents(TOP_UP.maxCents)}.
                </strong>{" "}
                Top-up credit lasts {TOP_UP.lastsMonths} months. Auto top-up stays off until you switch it on.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function PlanCard({ plan, subscription }: { plan: Plan; subscription: boolean }) {
  const recommended = plan.id === "pro";
  const free = plan.monthlyPriceCents === 0;
  return (
    <article className={recommended ? "plan plan-recommended" : "plan"}>
      <div className="plan-top">
        <div className="card-title-row">
          <h3>{plan.name}</h3>
          {recommended && <span className="badge badge-accent">RECOMMENDED</span>}
        </div>
        {free ? (
          <>
            <p className="plan-price">{formatCents(0)}</p>
            <p className="muted">{STARTER_LINE.charAt(0).toUpperCase() + STARTER_LINE.slice(1)}</p>
          </>
        ) : subscription ? (
          <>
            <p className="plan-price">
              {formatCents(plan.monthlyPriceCents)}
              <span> a month</span>
            </p>
            <p className="muted">Includes {formatCents(plan.planCreditCents)} of Plan credit every month, with no Fee.</p>
          </>
        ) : (
          <>
            <p className="plan-price">
              {formatCents(plan.unlockedAtCents)}
              <span> paid in total</span>
            </p>
            <p className="muted">
              {plan.name} limits unlock once your payments reach {formatCents(plan.unlockedAtCents)} in total.
            </p>
          </>
        )}
      </div>
      <ul className="plan-features">
        {planFeatures(plan).map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>
      <a href="#get-access" className={recommended ? "button button-primary plan-cta" : "button button-outline plan-cta"}>
        {free ? "Start free" : "Get early access"}
      </a>
    </article>
  );
}

function SelfHost() {
  return (
    <section id="self-host" className="section section-tight-top">
      <div className="container">
        <div className="self-host">
          <p className="eyebrow">Open source · Apache-2.0</p>
          <h2 className="section-title section-title-small">Rather run it yourself?</h2>
          <p className="section-lede">
            The Bot service is open source. Self-host it on your own Model provider keys with billing switched off.
            Linux Computers run on your own server in Docker.
          </p>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const answers = [
    ["Which models can my Bot use?", "Models from OpenAI, Anthropic, Google and xAI, and many more through OpenRouter. To operate a Computer, a Bot uses an OpenAI, Anthropic or Google model."],
    ["Do I need my own API keys?", "No. AI use runs on our keys and is paid from Credit. You can also add your own key to a Bot, and calls on it skip Credit and the Fee."],
    ["Why do I connect my own Telegram, Discord or Slack app?", "Your Bot talks through an app you register and own, so it carries your name and stays under your control. We walk you through setup on our website."],
    ["What happens when my Credit runs out?", "Your Bot says so and stops. Linux and Windows Computers go Asleep, and we keep their disks for 30 days while we email you. Auto top-up can buy more Credit for you, but only if you switch it on."],
    ["Where is my data kept?", "In the US. When you ask us to delete your data, we erase it within 30 days. Business Customers can sign a GDPR data processing agreement."],
    ["Can I get a refund?", `Unspent Top-up credit is refundable within ${TOP_UP.refundDays} days of purchase. Subscriptions cancel any time and end when the paid month ends.`],
  ];
  return (
    <section id="faq" className="section section-tight-top">
      <div className="container container-narrow stack-28">
        <h2 className="section-title">Questions</h2>
        <div className="faq">
          {answers.map(([question, answer]) => (
            <details key={question}>
              <summary>{question}</summary>
              <p className="muted">{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function GetAccess({ waitlist }: { waitlist: Waitlist }) {
  const error = waitlist.errorFor("cta");
  return (
    <section id="get-access" aria-labelledby="cta-title" className="section section-tight-top">
      <div className="container">
        <div className="cta-panel">
          <div className="cta-copy">
            <p className="eyebrow eyebrow-dark">Early access</p>
            <h2 id="cta-title" className="cta-title">
              Tell us what your Bot should do first.
            </h2>
            <p className="cta-lede">
              Sign-up opens at launch. Tell us what you'd hand off first, and we'll email you the day it opens.
            </p>
          </div>
          <div className="cta-side">
            {waitlist.joined ? (
              <Joined email={waitlist.email} large />
            ) : (
              <form className="cta-form" noValidate onSubmit={(event) => waitlist.join(event, "cta")}>
                <fieldset>
                  <legend>What should your Bot do first?</legend>
                  <div className="chips">
                    {FIRST_USES.map((use) => (
                      <button
                        key={use.id}
                        type="button"
                        className="chip"
                        aria-pressed={waitlist.firstUse === use.id}
                        onClick={() => waitlist.toggleFirstUse(use.id)}
                      >
                        {use.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div className="field">
                  <label htmlFor="cta-email" className="field-label field-label-strong">
                    Email
                  </label>
                  <input
                    id="cta-email"
                    className="input"
                    type="email"
                    autoComplete="email"
                    placeholder="you@company.com"
                    value={waitlist.email}
                    onChange={(event) => waitlist.setEmail(event.target.value)}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "cta-error" : undefined}
                  />
                  {error && (
                    <p id="cta-error" role="alert" className="form-error">
                      {error}
                    </p>
                  )}
                </div>
                <button type="submit" className="button button-primary button-large" disabled={waitlist.sending}>
                  Join the list
                </button>
                <p className="muted small">We'll email you once, when sign-up opens, and never share your address.</p>
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <span>© {new Date().getFullYear()} Kovobot. Kovobot is a working name.</span>
        <nav aria-label="Footer" className="footer-nav">
          <a href="#pricing">Pricing</a>
          <a href="#self-host">Self-host</a>
        </nav>
      </div>
    </footer>
  );
}
