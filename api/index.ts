import { webhookCallback } from "grammy";
import { bot } from "../src/bot";

const handle = webhookCallback(bot, "http");

export default async function handler(req: any, res: any) {
  try {
    await handle(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.status(500).send("Bot error");
    }
  }
}
