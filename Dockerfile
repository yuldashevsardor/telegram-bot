# syntax=docker/dockerfile:1

# Дублирует package.json#engines: связи между ними нет, синхронизировать вручную.
ARG NODE_VERSION=24.20.0

FROM node:${NODE_VERSION}-bookworm-slim

# fontforge-nox — headless-сборка: тот же /usr/bin/fontforge, но без зависимостей X11.
# Это ядро проекта: без бинарника конвертация шрифтов не работает вообще.
# procps — ради ps: Stryker (make mutation) гасит свои воркеры через tree-kill, а тот ищет
# дочерние процессы вызовом ps. В slim-образе его нет, и прогон падает на spawn ps ENOENT.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        fontforge-nox \
        ca-certificates \
        procps \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=development \
    HUSKY=0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

# /app принадлежит node, чтобы из-под него работали tsc (build/, typings/) и eslint --cache;
# сами файлы остаются root'овыми — исходники всё равно монтируются с хоста.
RUN mkdir -p tmp && chown node:node /app tmp

USER node

CMD ["npm", "run", "dev"]
