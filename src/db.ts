import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";
import { config } from "./config.ts";

export type Db = PrismaClient;

export function createDb(url = config.DATABASE_URL): PrismaClient {
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}

export * from "./generated/prisma/client.ts";
