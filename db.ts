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
  const fresh: User = {
    id,
    tgName: null,
    firstName: null,
    balance: 0,
    referrals: 0,
  };
  await redis.set(userKey(id), fresh);
  return fresh;
}

export async function saveUser(u: User) {
  await redis.set(userKey(u.id), u);
}

export async function addBalance(id: number, amt: number) {
  const u = await getUser(id);
  u.balance += amt;
  await saveUser(u);
  return u.balance;
}

export async function recordWithdrawRequest(id: number, amount: number) {
  const req = { id, amount, ts: Date.now() };
  await redis.lpush(withdrawKey(id), JSON.stringify(req));
  return req;
}

export async function listWithdrawRequests(id: number) {
  const arr = await redis.lrange<string>(withdrawKey(id), 0, 20);
  return arr.map((s) => JSON.parse(s));
}

export async function setPublicTasks(tasks: string[]) {
  await redis.set(tasksKey, tasks);
}
export async function getPublicTasks() {
  return (await redis.get<string[]>(tasksKey)) ?? [];
}
