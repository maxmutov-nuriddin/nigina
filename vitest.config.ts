import { defineConfig } from "vitest/config";

const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://nuriddin@localhost:5432/nigina_test?schema=public";

export default defineConfig({
  test: {
    globalSetup: ["tests/global-setup.ts"],
    // Barcha testlar bitta test bazasidan foydalanadi — ketma-ket
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: TEST_DB,
      TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN_NOT_REAL",
      GROQ_API_KEY: "",
      GROQ_ANALYSIS_API_KEY: "",
      GEMINI_API_KEY: "",
      REDIS_URL: "redis://localhost:6379",
      // .env'dagi cheklov testlarga ta'sir qilmasin (alohida test bor)
      ALLOWED_CHAT_IDS: "",
      OWNER_CHAT_ID: "0",
      STORAGE_DIR: "./tmp/test-storage",
      TMP_DIR: "./tmp/test-tmp",
    },
  },
});
