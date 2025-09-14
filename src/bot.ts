import { Bot, InlineKeyboard, GrammyError, HttpError } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { limit } from "@grammyjs/ratelimiter";
import {
  getUser, saveUser, addBalance, recordWithdrawRequest, listWithdrawRequests,
  getPublicTasks, User
} from "./db";

const TOKEN = process.env.BOT_TOKEN!;

// --- Force-Join config (usernames + private IDs with optional links) ---
const FORCE_CHANNELS = (process.env.FORCE_CHANNELS ?? "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

// same order as FORCE_CHANNELS; put invite links for private IDs
const FORCE_LINKS = (process.env.FORCE_LINKS ?? "")
  .split(",")
  .map((s) => s.trim());

const BONUS_AMOUNT = Number(process.env.BONUS_AMOUNT ?? 5);
const REF_BONUS = Number(process.env.REF_BONUS ?? 2);
const WITHDRAW_MIN = Number(process.env.WITHDRAW_MIN ?? 100);

export const bot = new Bot(TOKEN);

bot.api.config.use(autoRetry({ maxRetryAttempts: 3 }));
bot.use(limit({ timeFrame: 1000, limit: 3 }));

const dstr = (d = new Date()) => d.toISOString().slice(0, 10);

// ---- membership check (IDs or usernames) ----
async function isMemberAll(userId: number) {
  if (FORCE_CHANNELS.length === 0) return true;
  for (const ch of FORCE_CHANNELS) {
    try {
      const member = await bot.api.getChatMember(ch, userId);
      if (!["creator", "administrator", "member"].includes((member as any).status)) {
        return false;
      }
    } catch {
      // not a member or bot not admin / channel not visible
      return false;
    }
  }
  return true;
}

// ---- keyboard with proper links (invite for private IDs) ----
function forceJoinKeyboard() {
  const kb = new InlineKeyboard();

  FORCE_CHANNELS.forEach((ch, i) => {
    const explicit = FORCE_LINKS[i];
    let url: string | undefined;

    if (explicit && explicit.startsWith("http")) {
      // explicit invite/url provided
      url = explicit;
    } else if (!ch.startsWith("-100")) {
      // public username
      url = `https://t.me/${ch.replace("@", "")}`;
    }
    if (url) {
      kb.url(`Join Channel ${i + 1}`, url).row();
    } else {
      // private ID without invite link
      kb.text(`Join Channel ${i + 1}`, `noop_${i}`).row();
    }
  });

  kb.text("✅ मैंने सब join कर लिया", "check_join");
  return kb;
}

// optional handler so users get a clear alert on disabled buttons
bot.callbackQuery(/noop_\d+/, async (ctx) => {
  await ctx.answerCallbackQuery({
    text: "इस private channel का invite link missing है. Admin से लिंक लें.",
    show_alert: true,
  });
});

function mainKeyboard(name: string | null) {
  return new InlineKeyboard()
    .text(`🎁 Daily Bonus`, "daily_bonus")
    .text(`💰 Balance`, "balance")
    .row()
    .text(`👥 Refer & Earn`, "refer")
    .text(`📝 Tasks`, "tasks")
    .row()
    .text(`🏧 Withdraw`, "withdraw");
}

bot.command("start", async (ctx) => {
  const me = await getUser(ctx.from!.id);
  me.firstName = ctx.from?.first_name ?? me.firstName;
  me.tgName = ctx.from?.username ?? me.tgName;

  const payload = (ctx.match as string | undefined)?.trim();
  const refBy = Number(payload);
  if (refBy && refBy !== me.id && !me.refBy) {
    me.refBy = refBy;
  }
  await saveUser(me);

  const fname = me.firstName ?? "Friend";
  const tgname = me.tgName ? `(@${me.tgName})` : "";

  await ctx.reply(
    `Hi ${fname} ${tgname}, kaise ho aap? 👋\n\n` +
      `👉 पहले इन सभी चैनल्स को join करें, फिर नीचे बटन इस्तेमाल करें।`,
    { reply_markup: forceJoinKeyboard() }
  );
});

bot.callbackQuery("check_join", async (ctx) => {
  const ok = await isMemberAll(ctx.from.id);
  if (ok) {
    const u = await getUser(ctx.from.id);
    if (u.refBy && !(u as User)._firstBonusCredited) {
      await addBalance(u.refBy, REF_BONUS);
      (u as User)._firstBonusCredited = true;
      await saveUser(u);
      try {
        await ctx.api.sendMessage(
          u.refBy,
          `🎉 आपके रेफ़रल ${u.firstName ?? "User"} ने verify कर लिया। आपको +${REF_BONUS}!`
        );
      } catch {}
    }
    await ctx.answerCallbackQuery({ text: "✅ Verified! आपने सभी channels join कर लिए।" });
    await ctx.editMessageText(
      "✅ Verification complete! अब नीचे के बटनों से कमाना शुरू करें:",
      { reply_markup: mainKeyboard(ctx.from.first_name ?? null) }
    );
  } else {
    await ctx.answerCallbackQuery({
      text: "❗ अभी सारे channel join नहीं दिख रहे। Join करके दुबारा दबाएँ।",
      show_alert: true,
    });
  }
});

async function guardJoined(ctx: any) {
  if (!(await isMemberAll(ctx.from.id))) {
    await ctx.reply("⚠️ पहले सभी Force Channels join करें, फिर try करें.", {
      reply_markup: forceJoinKeyboard(),
    });
    return false;
  }
  return true;
}

bot.callbackQuery("daily_bonus", async (ctx) => {
  if (!(await guardJoined(ctx))) return;
  const u = await getUser(ctx.from.id);
  const today = dstr();
  if (u.lastBonusDate === today) {
    await ctx.answerCallbackQuery({ text: "आज का bonus आप ले चुके हैं. कल मिलेंगे! 😊", show_alert: true });
    return;
  }
  u.lastBonusDate = today;
  u.balance += BONUS_AMOUNT;
  await saveUser(u);

  await ctx.answerCallbackQuery({ text: `🎁 +${BONUS_AMOUNT} credit added!` });
  await ctx.reply(`🎁 Daily Bonus credited: +${BONUS_AMOUNT}\n💰 Current Balance: ${u.balance}`);
});

bot.callbackQuery("balance", async (ctx) => {
  if (!(await guardJoined(ctx))) return;
  const u = await getUser(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply(`💰 आपका Balance: *${u.balance}*`, { parse_mode: "Markdown" });
});

bot.callbackQuery("refer", async (ctx) => {
  const me = await getUser(ctx.from.id);
  const botInfo = await ctx.api.getMe();
  const link = `https://t.me/${botInfo.username}?start=${me.id}`;
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `👥 *Refer & Earn*\n\n` +
      `अपना link share करें:\n${link}\n\n` +
      `जब आपका friend verify करेगा, आपको +${REF_BONUS} मिलेगा.`,
    { parse_mode: "Markdown" }
  );
});

bot.callbackQuery("tasks", async (ctx) => {
  if (!(await guardJoined(ctx))) return;
  const tasks = await getPublicTasks();
  await ctx.answerCallbackQuery();
  if (tasks.length === 0) {
    await ctx.reply("📝 अभी कोई task उपलब्ध नहीं है. बाद में चेक करें.");
  } else {
    const list = tasks.map((t, i) => `${i + 1}. ${t}`).join("\n");
    await ctx.reply(
      `📝 *Available Tasks:*\n${list}\n\n(पूरा करने के बाद proof भेजें – admin verify करेगा)`,
      { parse_mode: "Markdown" }
    );
  }
});

bot.callbackQuery("withdraw", async (ctx) => {
  if (!(await guardJoined(ctx))) return;
  const u = await getUser(ctx.from.id);
  await ctx.answerCallbackQuery();
  if (u.balance < WITHDRAW_MIN) {
    await ctx.reply(`❗ Withdraw min ${WITHDRAW_MIN} है. आपका balance: ${u.balance}`);
    return;
  }
  await ctx.reply("🏧 Withdraw के लिए amount (number) reply करें, या /cancel लिखें.");
  const handler = async (msgCtx: any) => {
    if (msgCtx.from.id !== ctx.from.id) return;
    const text = msgCtx.message.text?.trim() ?? "";
    if (text.toLowerCase() === "/cancel") {
      await msgCtx.reply("❌ Withdraw cancel किया गया.");
      bot.off("message:text", handler);
      return;
    }
    const amt = Number(text);
    if (!Number.isFinite(amt) || amt <= 0) {
      await msgCtx.reply("कृपया valid number भेजें, या /cancel करें.");
      return;
    }
    const user = await getUser(msgCtx.from.id);
    if (amt > user.balance) {
      await msgCtx.reply(`आपके पास उतना balance नहीं है. Current: ${user.balance}`);
      return;
    }
    user.balance -= amt;
    await saveUser(user);
    const req = await recordWithdrawRequest(user.id, amt);
    await msgCtx.reply(`✅ Withdraw request received: ${amt}\n🆔 ${req.ts}\n⏳ Admin review के बाद payout होगा.`);
    bot.off("message:text", handler);
  };
  bot.on("message:text", handler);
});

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Bot error for update ${ctx.update.update_id}:`, err.error);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error("Grammy error:", (e as any).description);
  } else if (e instanceof HttpError) {
    console.error("HTTP error:", e);
  } else {
    console.error("Unknown error:", e);
  }
});
