import { execSync } from "node:child_process";

/** Test bazasiga migratsiyalarni qo'llaydi (alohida baza: nigina_test). */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? `postgresql://${process.env.USER}@localhost:5432/nigina_test?schema=public`;
  if (!/test/i.test(url)) throw new Error("Testlar faqat nomida 'test' bo'lgan bazada ishlaydi");
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
}
