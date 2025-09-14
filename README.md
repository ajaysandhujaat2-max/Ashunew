# Telegram Force-Join Bot (7 Channels) — Vercel + Upstash

This repo is ready for **non-coders**. Just upload to GitHub and deploy on Vercel.

## What this bot does
- Force user to **join 7 channels** (you can set any number via `FORCE_CHANNELS` env).
- `/start` shows **join links** + verify button.
- Features: **Daily Bonus**, **Balance**, **Refer & Earn**, **Tasks**, **Withdraw request**.
- Data stored in **Upstash Redis (free)**.

---

## Step-by-step (No Coding)

### 1) Create a Telegram Bot
- In Telegram, open **@BotFather**
- Send `/newbot` → set name and username → copy **BOT_TOKEN**

### 2) Create Redis (free)
- Go to **Upstash Redis** → create a database
- Copy **REST URL** and **REST TOKEN**

### 3) Upload this folder to GitHub
- Make a new repo (e.g., `telegram-bot`)
- Upload all files as-is

### 4) Deploy on Vercel
- Click **New Project** → **Import from GitHub**
- After importing, open **Project → Settings → Environment Variables** and add:

| Key | Value |
| --- | --- |
| BOT_TOKEN | `123456:ABC...` from BotFather |
| WEBHOOK_URL | `https://YOUR-APP.vercel.app/api` |
| FORCE_CHANNELS | `@ch1,@ch2,@ch3,@ch4,@ch5,@ch6,@ch7` (or IDs like `-100...`) |
| BONUS_AMOUNT | e.g. `5` |
| REF_BONUS | e.g. `2` |
| WITHDRAW_MIN | e.g. `100` |
| UPSTASH_REDIS_REST_URL | from Upstash |
| UPSTASH_REDIS_REST_TOKEN | from Upstash |

- Press **Deploy**

### 5) Set Webhook (1 click in browser)
Open this in your browser (replace token & URL):
```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=<YOUR_WEBHOOK_URL>
```
Example:
```
https://api.telegram.org/bot123456:ABC/setWebhook?url=https://your-app.vercel.app/api
```

### 6) Make your bot an Admin in your channels
- Add the bot to **all 7 channels**. For private channels, give it access.

### 7) Test
- In Telegram, open your bot → send `/start` → join channels → press **✅**

---

## Editing the channels
- You **do not need to edit code**.
- Just change the env value **FORCE_CHANNELS** in Vercel, comma-separated:
```
@channel1,@channel2,@channel3,@channel4,@channel5,@channel6,@channel7
```
(Use `-100XXXXXXXXXX` if using channel IDs.)

---

## Optional: Add Tasks
- For now, tasks are a static list in Redis (admin can set later).

## Notes
- If `/start` works but verify fails, make sure the bot is **inside each channel**.
- If webhook fails, re-run the setWebhook URL after your Vercel deploy is live.
