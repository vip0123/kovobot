import { Link } from "react-router";
import { AppShell, PageHeader, useShell } from "../AppShell.tsx";
import { BotAvatar } from "../BotAvatar.tsx";
import { PlusIcon } from "../Icons.tsx";
import { modelLabel } from "../ModelPicker.tsx";
import { NewBotForm } from "./NewBotPage.tsx";

export function BotsPage() {
  return (
    <AppShell>
      <BotHome />
    </AppShell>
  );
}

/** The Customer's Bots; with none yet, making the first one. */
function BotHome() {
  const { bots, catalog } = useShell();

  if (bots.length === 0) {
    return (
      <main className="main-page">
        <PageHeader>
          <h1 className="page-title">Bots</h1>
        </PageHeader>
        <div className="page-body welcome">
          <span className="logo-mark welcome-mark" aria-hidden="true" />
          <h2 className="welcome-title">Make your first Bot</h2>
          <p className="muted welcome-text">
            A Bot chats with you here, remembers your Conversation and, with a Computer, works on its own Linux desktop.
          </p>
          <section className="form-card">
            <NewBotForm />
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="main-page">
      <PageHeader>
        <h1 className="page-title">Bots</h1>
      </PageHeader>
      <div className="page-body">
        <ul className="bot-grid">
          {bots.map((bot) => (
            <li key={bot.id}>
              <Link to={`/bots/${bot.id}`} className="bot-card">
                <BotAvatar id={bot.id} name={bot.name} size="large" />
                <span className="bot-card-text">
                  <span className="bot-card-name">{bot.name}</span>
                  <span className="muted small">{modelLabel(catalog, bot.model)}</span>
                </span>
              </Link>
            </li>
          ))}
          <li>
            <Link to="/bots/new" className="bot-card bot-card-new">
              <span className="avatar avatar-large avatar-new" aria-hidden="true">
                <PlusIcon />
              </span>
              <span className="bot-card-text">
                <span className="bot-card-name">New Bot</span>
                <span className="muted small">Pick a name and a model</span>
              </span>
            </Link>
          </li>
        </ul>
      </div>
    </main>
  );
}
