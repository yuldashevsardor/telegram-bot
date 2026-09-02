# syntax=docker/dockerfile:1

# Версия зафиксирована по .nvmrc и package.json#engines.
ARG NODE_VERSION=24.20.0

FROM node:${NODE_VERSION}-bookworm-slim AS base

# fontforge-nox — headless-сборка: тот же /usr/bin/fontforge, но без зависимостей X11.
# Это ядро проекта: без бинарника конвертация шрифтов не работает вообще.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        fontforge-nox \
        python3 \
        # без pkg_resources fontforge пишет в stderr предупреждение на каждый запуск
        python3-pkg-resources \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=development \
    HUSKY=0

WORKDIR /app


FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts


FROM base AS prod-deps

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts


FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Bot.setupFlavor ищет .ftl по пути <cwd>/src/infrastructure/bot, а tsc их в build/ не копирует.
# Складываем локали отдельно, чтобы в runtime-образ попали только они, без исходников.
RUN mkdir -p /locales && find src -name "*.ftl" -exec cp --parents {} /locales/ \;


# Образ для локальной разработки и для прогона миграций: содержит devDependencies,
# ts-node и исходники — node-pg-migrate выполняет .ts-миграции напрямую.
FROM deps AS development

COPY . .
RUN mkdir -p tmp && chown node:node tmp
USER node

CMD ["npm", "run", "dev"]


FROM base AS production

ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /locales/src ./src
COPY package.json ./
RUN mkdir -p tmp && chown node:node tmp
USER node

CMD ["node", "build/app.js"]
