import { logger as defaultLogger, type Logger } from './logger.js';

export type Severity = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export interface NotifierOptions {
  telegram?: { botToken: string; chatId: string };
  discordWebhookUrl?: string;
  logger?: Logger;
}

export class Notifier {
  private readonly telegram?: { botToken: string; chatId: string };
  private readonly discordWebhookUrl?: string;
  private readonly log: Logger;

  constructor(opts: NotifierOptions) {
    if (opts.telegram) this.telegram = opts.telegram;
    if (opts.discordWebhookUrl) this.discordWebhookUrl = opts.discordWebhookUrl;
    this.log = opts.logger ?? defaultLogger;
  }

  async send(sev: Severity, message: string): Promise<void> {
    const text = `[${sev}] ${new Date().toISOString()}\n${message}`;
    const tasks: Promise<unknown>[] = [];

    if (this.discordWebhookUrl) {
      tasks.push(this.postDiscord(this.discordWebhookUrl, text));
    }
    if (this.telegram) {
      tasks.push(this.postTelegram(this.telegram.botToken, this.telegram.chatId, text));
    }

    await Promise.allSettled(tasks);
  }

  info(message: string): Promise<void> { return this.send('INFO', message); }
  warn(message: string): Promise<void> { return this.send('WARN', message); }
  error(message: string): Promise<void> { return this.send('ERROR', message); }
  critical(message: string): Promise<void> { return this.send('CRITICAL', message); }

  private async postDiscord(url: string, content: string): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) this.log.warn({ status: res.status }, 'discord webhook non-2xx');
    } catch (e) {
      this.log.warn({ err: e }, 'discord webhook post failed');
    }
  }

  private async postTelegram(token: string, chatId: string, text: string): Promise<void> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) this.log.warn({ status: res.status }, 'telegram send failed');
    } catch (e) {
      this.log.warn({ err: e }, 'telegram send threw');
    }
  }
}
