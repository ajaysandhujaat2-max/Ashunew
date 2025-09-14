import { Bot, InlineKeyboard, GrammyError, HttpError } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { limit } from "@grammyjs/ratelimiter";
import {
  getUser, saveUser, addBalance, recordWithdrawRequest, listWithdrawRequests,
  getPublicTasks, User,
  trackUser, isBanned, banUser, unbanUser,
  getMemberCached, setMemberCached,
  enqueueWithdraw, listPendingWithdraws, markWithdraw
} from "./db";

const TOKEN = process.env.BOT_TOKEN!;

// Force-join config
const FORCE_CHANNELS = (process.env.FORCE_CHANNELS ?? "")
  .split(",").map(c => c.trim()).filter(Boolean);
const FORCE_LINKS = (process.env.FORCE_LINKS ?? "")
  .split(",").map(s => s.trim());

const BONUS_AMOUNT = Number(process.env.BONUS_AMOUNT ?? 5);
const REF_BONUS = Number(process.env.REF_BONUS ?? 2);
const WITHDRAW_MIN = Number(process.env.WITHDRAW_MIN ?? 100);

// Admins (comma separated)
const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",").map(s => Number(s.trim())).filter(Boolean);

export const bot = new Bot(TOKEN);

// reliability & throttling
bot.api.config.use(autoRetry({ maxRetryAttempts: 3 }));
bot.use(limit({ timeFrame: 1000, limit: 3 }));

const dstr = (d = new Date()) => d.toISOString().slice(0, 10);

// cached membership check
async function isMemberAll(userId: number) {
  if (FORCE_CHANNELS.length === 0) return true;
  for (const ch of FORCE_CHANNELS) {
    const cached = await getMemberCached(ch, userId);
    if (cached === true) continue;
    try {
      const member = await bot.api.getChatMember(ch, userId);
      const ok = ["creator","administrator","member"].includes((member as any).status);
      await setMemberCached(ch, userId, ok);
      if (!ok) return false;
    } catch {
      await setMemberCached(ch, userId, false);
      return false;
    }
  }
  return true;
}

// keyboard with invite/public links
function forceJoinKeyboard() {
  const kb = new InlineKeyboard();
  FORCE_CHANNELS.forEach((ch, i) => {
    const explicit = FORCE_LINKS[i];
    let url: string | undefined;
    if (explicit && explicit.startsWith("http")) url = explicit;
    else if (!ch.startsWith("-100")) url = `https://t.me/${ch.replace("@","")}`;
    if (url) kb.url(`Join Channel ${i+1}`, url).row();
    else kb.text(`Join Channel ${i+1}`, `noop_${i}`).row();
  });
  kb.text("✅ मैंने सब join कर लिया", "check_join");
  return kb;
}
bot.callbackQuery(/noop_\d+/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Private channel link missing. Admin se invite link lo.", show_alert: true });
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
  if (await isBanned(ctx.from!.id)) return;
  await trackUser(ctx.from!.id);

  const me = await getUser(ctx.from!.id);
  me.firstName = ctx.from?.first_name ?? me.firstName;
  me.tgName = ctx.from?.username ?? me.tgName;

  const payload = (ctx.match as string | undefined)?.trim();
  const refBy = Number(payload);
  if (refBy && refBy !== me.id && !me.refBy) me.refBy = refBy;
  await saveUser(me);

  const fname = me.firstName ?? "Friend";
  const tgname = me.tgName ? `(@${me.tgName})` : "";
  await ctx.reply(
    `Hi ${fname} ${tgname}, kaise ho aap? 👋\n\n👉 पहले सभी channels join करो, फिर नीचे बटनों से earn करो.`,
    { reply_markup: forceJoinKeyboard() }
  );
});

bot.callbackQuery("check_join", async (ctx) => {
  if (await isBanned(ctx.from!.id)) return ctx.answerCallbackQuery();
  const ok = await isMemberAll(ctx.from.id);
  if (ok) {
    const u = await getUser(ctx.from.id);
    if (u.refBy && !(u as User)._firstBonusCredited) {
      await addBalance(u.refBy, REF_BONUS);
      (u as User)._firstBonusCredited = true;
      await saveUser(u);
      try { await ctx.api.sendMessage(u.refBy, `🎉 आपके रेफ़रल ${u.firstName ?? "User"} ने verify किया। +₹${REF_BONUS}`); } catch {}
    }
    await ctx.answerCallbackQuery({ text: "✅ Verified!" });
    await ctx.editMessageText("✅ Verification complete! अब नीचे के बटनों से कमाना शुरू करें:", { reply_markup: mainKeyboard(ctx.from.first_name ?? null) });
  } else {
    await ctx.answerCallbackQuery({ text: "❗ अभी सारे channel join नहीं दिख रहे।", show_alert: true });
  }
});

async function guardJoined(ctx: any) {
  if (await isBanned(ctx.from!.id)) return false;
  if (!(await isMemberAll(ctx.from.id))) {
    await ctx.reply("⚠️ पहले सभी Force Channels join करें, फिर try करें.", { reply_markup: forceJoinKeyboard() });
    return false;
  }
  return true;
}

bot.callbackQuery("daily_bonus", async (ctx) => {
  if (!(await guardJoined(ctx))) return;
  const u = await getUser(ctx.from.id);
  const today = dstr();
  if (u.lastBonusDate === today) {
    await ctx.answerCallbackQuery({ text: "आज का bonus ले चुके हैं. कल मिलेंगे! 😊", show_alert: true });
    return;
  }
  u.lastBonusDate = today;
  u.balance = Math.round((u.balance + BONUS_AMOUNT) * 100) / 100;
  await saveUser(u);

  await ctx.answerCallbackQuery({ text: `🎁 +₹${BONUS_AMOUNT}` });
  await ctx.reply(`🎁 Daily Bonus: +₹${BONUS_AMOUNT}\n💰 Balance: ₹${u.balance.toFixed(2)}`);
});

bot.callbackQuery("balance", async (ctx) => {
  if (!(await guardJoined(ctx))) return;
  const u = await getUser(ctx.from.id);
  await ctx.answerCallbackQuery();
  await ctx.reply(`💰 आपका Balance: *₹${u.balance.toFixed(2)}*`, { parse_mode: "Markdown" });
});

bot.callbackQuery("refer", async (ctx) => {
  if (!(await guardJoined(ctx))) return;
  const me = await getUser(ctx.from.id);
  const botInfo = await ctx.api.getMe();
  const link = `https://t.me/${botInfo.username}?start=${me.id}`;
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `👥 *Refer & Earn*\n\nआपका link:\n${link}\n\nFriend verify करेगा तो आपको +₹${REF_BONUS}.`,
    { parse_mode: "Markdown" }
  );
});

bot.callbackQuery("tasks", async (ctx) => {
  if (!(await guardJoined(ctx))) return;
  const tasks = await getPublicTasks();
  await ctx.answerCallbackQuery();
  if (tasks.length === 0) await ctx.reply("📝 अभी कोई task उपलब्ध नहीं है.");
  else {
    const list = tasks.map((t, i) => `${i + 1}. ${t}`).join("\n");
    await ctx.reply(`📝 *Tasks:*\n${list}\n\n(Proof भेजें – admin verify करेगा)`, { parse_mode: "Markdown" });
  }
});

bot.callbackQuery("withdraw", async (ctx) => {
  if (!(await guardJoined(ctx))) return;
  const u = await getUser(ctx.from.id);
  await ctx.answerCallbackQuery();
  if (u.balance < WITHDRAW_MIN) return ctx.reply(`❗ Minimum withdraw ₹${WITHDRAW_MIN}. आपका balance: ₹${u.balance.toFixed(2)}`);

  await ctx.reply("🏧 Withdraw amount (₹) reply करें, या /cancel लिखें.");
  let step: "amount"|"upi" = "amount"; let amount = 0;

  const handler = async (msgCtx: any) => {
    if (msgCtx.from.id !== ctx.from.id) return;
    const text = msgCtx.message.text?.trim() ?? "";

    if (text.toLowerCase() === "/cancel") { await msgCtx.reply("❌ Withdraw cancel."); bot.off("message:text", handler); return; }

    if (step === "amount") {
      const amt = Number(text);
      if (!Number.isFinite(amt) || amt <= 0) return msgCtx.reply("कृपया valid number भेजें, या /cancel.");
      const user = await getUser(msgCtx.from.id);
      if (amt > user.balance) return msgCtx.reply(`Balance कम है. Current: ₹${user.balance.toFixed(2)}`);
      amount = Math.floor(amt * 100) / 100;
      step = "upi";
      await msgCtx.reply("✅ Amount noted. अब अपना **UPI ID** भेजें (e.g., name@upi).", { parse_mode: "Markdown" });
      return;
    }

    if (step === "upi") {
      const upi = text;
      if (!/^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/.test(upi)) return msgCtx.reply("⚠️ सही UPI भेजें (e.g., name@upi) या /cancel.");

      const user = await getUser(msgCtx.from.id);
      user.balance = Math.max(0, Math.round((user.balance - amount) * 100) / 100); // hold
      await saveUser(user);

      const req = await enqueueWithdraw(user.id, amount, upi);
      await msgCtx.reply(`✅ Withdraw request received\n🆔 ${req.reqId}\n₹${amount} → ${upi}\n⏳ Admin review बाद payout होगा.`);

      for (const adminId of ADMIN_IDS) {
        const kb = new InlineKeyboard().text("✅ Approve", `w_approve:${req.reqId}`).text("❌ Reject", `w_reject:${req.reqId}`);
        await bot.api.sendMessage(
          adminId,
          `🧾 *Withdraw Request*\nUser: ${user.firstName ?? "User"} (ID ${user.id})\nUPI: ${upi}\nAmount: ₹${amount}\nReqID: ${req.reqId}`,
          { parse_mode: "Markdown", reply_markup: kb }
        );
      }
      bot.off("message:text", handler);
    }
  };
  bot.on("message:text", handler);
});

bot.callbackQuery(/^w_(approve|reject):(.+)$/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCallbackQuery({ text: "Not admin." });
  const [, action, reqId] = ctx.match as RegExpMatchArray;
  const it = await markWithdraw(reqId, action === "approve" ? "approved" : "rejected");
  if (!it) return ctx.answerCallbackQuery({ text: "Not found / already handled" });

  const u = await getUser(it.userId);

  if (action === "approve") {
    await ctx.api.sendMessage(u.id, "🎉 Congratulations! Check your Bank/UPI app — withdrawal processed.");
    await ctx.editMessageText(`✅ Approved: ₹${it.amount} to ${it.upi} (Req ${it.reqId})`);
  } else {
    u.balance = Math.round((u.balance + it.amount) * 100) / 100;
    await saveUser(u);
    await ctx.api.sendMessage(u.id, "❌ Your withdraw cancelled. Coins refunded — please try again.");
    await ctx.editMessageText(`❌ Rejected & refunded: ₹${it.amount} (Req ${it.reqId})`);
  }
  await ctx.answerCallbackQuery({ text: action === "approve" ? "Approved" : "Rejected" });
});

// Admin panel
function adminKb() {
  return new InlineKeyboard()
    .text("➕ Coin", "a_add")
    .text("➖ Coin", "a_sub")
    .row()
    .text("📢 Broadcast", "a_bc")
    .row()
    .text("🚫 Ban", "a_ban")
    .text("✅ Unban", "a_unban")
    .row()
    .text("💸 Pending Withdraws", "a_wlist");
}
bot.command("admin", async (ctx) => { if (ADMIN_IDS.includes(ctx.from!.id)) await ctx.reply("🔧 Admin Panel", { reply_markup: adminKb() }); });

const askOnce = (ctx: any, prompt: string, handler: (msgCtx:any, text:string)=>Promise<void>) => {
  ctx.reply(prompt + "\n/cancel to abort");
  const h = async (m:any) => {
    if (m.from.id !== ctx.from.id) return;
    const t = m.message.text?.trim() ?? "";
    if (t.toLowerCase() === "/cancel") { await m.reply("Cancelled."); bot.off("message:text", h); return; }
    await handler(m, t);
    bot.off("message:text", h);
  };
  bot.on("message:text", h);
};

bot.callbackQuery("a_add", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return; await ctx.answerCallbackQuery();
  askOnce(ctx, "User ID और amount: `123456 10`", async (m, t) => {
    const [idS, amtS] = t.split(/[,\s]+/); const id = Number(idS), amt = Number(amtS);
    if (!id || !amt) return m.reply("Format: 123456 10");
    const u = await getUser(id); u.balance = Math.round((u.balance + amt) * 100)/100; await saveUser(u);
    await m.reply(`✅ Added ₹${amt} to ${id}. New bal: ₹${u.balance.toFixed(2)}`);
    try { await bot.api.sendMessage(id, `💰 Admin ने आपके अकाउंट में ₹${amt} जोड़ दिए हैं.`); } catch {}
  });
});
bot.callbackQuery("a_sub", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return; await ctx.answerCallbackQuery();
  askOnce(ctx, "User ID और amount: `123456 5`", async (m, t) => {
    const [idS, amtS] = t.split(/[,\s]+/); const id = Number(idS), amt = Number(amtS);
    if (!id || !amt) return m.reply("Format: 123456 5");
    const u = await getUser(id); u.balance = Math.max(0, Math.round((u.balance - amt) * 100)/100); await saveUser(u);
    await m.reply(`✅ Subtracted ₹${amt} from ${id}. New bal: ₹${u.balance.toFixed(2)}`);
    try { await bot.api.sendMessage(id, `💰 Admin ने आपके अकाउंट से ₹${amt} घटाए हैं.`); } catch {}
  });
});
bot.callbackQuery("a_bc", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return; await ctx.answerCallbackQuery();
  askOnce(ctx, "Broadcast message भेजें:", async (m, text) => {
    let sent = 0;
    try {
      const batch = await listUsers(0, 1000);
      for (const uid of (batch.members ?? [])) {
        try { await bot.api.sendMessage(Number(uid), text); sent++; } catch {}
      }
    } catch {}
    await m.reply(`📢 Broadcast sent to ~${sent} users.`);
  });
});
bot.callbackQuery("a_ban", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return; await ctx.answerCallbackQuery();
  askOnce(ctx, "Ban user ID:", async (m, idS) => {
    const id = Number(idS); if (!id) return m.reply("Invalid ID");
    await banUser(id); await m.reply(`🚫 Banned ${id}`);
  });
});
bot.callbackQuery("a_unban", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return; await ctx.answerCallbackQuery();
  askOnce(ctx, "Unban user ID:", async (m, idS) => {
    const id = Number(idS); if (!id) return m.reply("Invalid ID");
    await unbanUser(id); await m.reply(`✅ Unbanned ${id}`);
  });
});
bot.callbackQuery("a_wlist", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return; await ctx.answerCallbackQuery();
  const list = await listPendingWithdraws(20);
  if (list.length === 0) return ctx.reply("No pending withdraws.");
  for (const it of list) {
    const kb = new InlineKeyboard().text("✅ Approve", `w_approve:${it.reqId}`).text("❌ Reject", `w_reject:${it.reqId}`);
    await ctx.reply(`ReqID: ${it.reqId}\nUser: ${it.userId}\nUPI: ${it.upi}\nAmount: ₹${it.amount}`, { reply_markup: kb });
  }
});

// global errors
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Bot error for update ${ctx.update.update_id}:`, err.error);
  const e = err.error;
  if (e instanceof GrammyError) console.error("Grammy error:", (e as any).description);
  else if (e instanceof HttpError) console.error("HTTP error:", e);
  else console.error("Unknown error:", e);
});
