import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router";
import { BotPage } from "./pages/BotPage.tsx";
import { BotsPage } from "./pages/BotsPage.tsx";
import { ConfirmSignInPage } from "./pages/ConfirmSignInPage.tsx";
import { NewBotPage } from "./pages/NewBotPage.tsx";
import { SignInPage } from "./pages/SignInPage.tsx";
import { SkillPage, SkillsPage } from "./pages/SkillsPage.tsx";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/bots" replace />} />
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/sign-in/confirm" element={<ConfirmSignInPage />} />
        <Route path="/bots" element={<BotsPage />} />
        <Route path="/bots/new" element={<NewBotPage />} />
        <Route path="/bots/:id" element={<BotPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/skills/:id" element={<SkillPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}

function NotFoundPage() {
  return (
    <main className="centered">
      <div className="card">
        <h1>Page not found</h1>
        <p className="muted">
          <Link to="/bots">Go to your Bots</Link>
        </p>
      </div>
    </main>
  );
}
