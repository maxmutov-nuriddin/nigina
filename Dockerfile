# syntax=docker/dockerfile:1
FROM node:24-slim AS base
# ffmpeg — Groq qabul qilmaydigan audio formatlarini aylantirish uchun
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build

# Migratsiyalar uchun (prisma CLI devDependency'da)
FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/storage /app/tmp && chown -R node:node /app
USER node
CMD ["node", "dist/main.js"]
