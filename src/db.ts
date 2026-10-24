import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";
import { config } from "./config.ts";

export type Db = PrismaClient;

export function createDb(url = config.DATABASE_URL): PrismaClient {
  // Sessiya vaqt mintaqasi UTC: adapter Date'ni mintaqasiz yuboradi — server TimeZone'i (masalan Asia/Tashkent)
  // boshqa bo'lsa timestamptz qiymatlari siljiydi. UTC bilan qaysi serverga ulanmasin, vaqt to'g'ri yoziladi.
  const adapter = new PrismaPg({ connectionString: url, options: "-c TimeZone=UTC" });
  return new PrismaClient({ adapter });
}

export * from "./generated/prisma/client.ts";
