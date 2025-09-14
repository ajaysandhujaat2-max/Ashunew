import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export type User = {
  id: number;
  tgName: string | null;
  firstName: string | null;
  balance: number;
  lastBonusDate?: string;
  refBy?: number;
  referrals?: number;
  _firstBonusCredited?: boolean;
};

const userKey = (id: number) => `u:${id}`;
const withdrawKey = (id: number) => `wreq:${id}`;
const tasksKey = `tasks:public`;

export async function getUser(id: number): Promise<User> {
  const data = await redis.get<User>(userKey(id));
  if (data) return data;
  const fresh: User = { id, tgName: null, firstName: null, balance: 0, referrals: 0 };
  await redis.set(userKey(id), fresh);
  return fresh;
}
export async function saveUser(u: User) { await redis.set(userKey(u.id), u); }
export async function addBalance(id: number, amt: number) {
  const u = await getUser(id); u.balance += amt; await saveUser(u); return u.balance;
}
export async function recordWithdrawRequest(id: number, amount: number) {
  const req = { id, amount, ts: Date.now() }; await redis.lpush(withdrawKey(id), JSON.stringify(req)); return req;
}
export async function listWithdrawRequests(id: number) {
  const arr = await redis.lrange<string>(withdrawKey(id), 0, 20); return arr.map(s => JSON.parse(s));
}
export async function setPublicTasks(tasks: string[]) { await redis.set(tasksKey, tasks); }
export async function getPublicTasks() { return (await redis.get<string[]>(tasksKey)) ?? []; }

/* ---------- Speed & Admin Utilities ---------- */
const usersSetKey = `users:all`;
const bansKey = `bans:set`;
const memberCacheKey = (ch: string, uid: number) => `m:${ch}:${uid}`; // TTL bool
const withdrawQueueKey = `wreq:pending`;
const withdrawItemKey = (reqId: string) => `wreq:item:${reqId}`;

export async function trackUser(id: number) { await redis.sadd(usersSetKey, id); }
export async function listUsers(offset = 0, count = 1000) { return await redis.sscan(usersSetKey, offset, { count }); }

export async function isBanned(id: number) { return (await redis.sismember(bansKey, id)) === 1; }
export async function banUser(id: number) { await redis.sadd(bansKey, id); }
export async function unbanUser(id: number) { await redis.srem(bansKey, id); }

export async function getMemberCached(ch: string, uid: number) { return (await redis.get<string>(memberCacheKey(ch, uid))) === "1"; }
export async function setMemberCached(ch: string, uid: number, is: boolean) { await redis.set(memberCacheKey(ch, uid), is ? "1" : "0", { ex: 15 * 60 }); }

export type WithdrawReq = { reqId: string; userId: number; amount: number; upi: string; ts: number; status: "pending"|"approved"|"rejected" };

export async function enqueueWithdraw(u: number, amount: number, upi: string) {
  const reqId = String(Date.now()) + ":" + u;
  const item: WithdrawReq = { reqId, userId: u, amount, upi, ts: Date.now(), status: "pending" };
  await redis.set(withdrawItemKey(reqId), item);
  await redis.lpush(withdrawQueueKey, reqId);
  return item;
}
export async function listPendingWithdraws(limit = 20): Promise<WithdrawReq[]> {
  const ids = await redis.lrange<string>(withdrawQueueKey, 0, limit - 1);
  const items = await Promise.all(ids.map(id => redis.get<WithdrawReq>(withdrawItemKey(id))));
  return items.filter(Boolean) as WithdrawReq[];
}
export async function markWithdraw(reqId: string, status: "approved"|"rejected") {
  const it = await redis.get<WithdrawReq>(withdrawItemKey(reqId));
  if (!it) return null;
  it.status = status;
  await redis.set(withdrawItemKey(reqId), it);
  await redis.lrem(withdrawQueueKey, 0, reqId);
  return it;
}
