import nodemailer from "nodemailer";
import type { EmailSettings } from "@kovobot/config";

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

/** Sends by SMTP, or (self-hosted without SMTP) writes each email to the server log. */
export function createMailer(settings: EmailSettings): Mailer {
  if (settings.kind === "log") {
    return {
      async send(email) {
        console.info(`Email to ${email.to}: ${email.subject}\n${email.text}`);
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.port === 465,
    auth: settings.user ? { user: settings.user, pass: settings.password } : undefined,
  });
  return {
    async send(email) {
      await transport.sendMail({ from: settings.from, ...email });
    },
  };
}
