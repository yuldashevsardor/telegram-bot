# syntax=docker/dockerfile:1

# Duplicates package.json#engines: there is no link between the two, keep them in sync by hand.
ARG NODE_VERSION=24.20.0

FROM node:${NODE_VERSION}-bookworm-slim

# fontforge-nox is the headless build: the same /usr/bin/fontforge without the X11 dependencies.
# It is the core of the project: without the binary no font converts at all.
# procps provides ps: Stryker (make mutation) kills its workers through tree-kill, which finds the
# child processes by calling ps. The slim image has no ps, and the run fails with spawn ps ENOENT.
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

# /app belongs to node so that tsc (build/, typings/) and eslint --cache work as that user. The
# files themselves stay root's: the sources are mounted from the host anyway.
RUN mkdir -p tmp && chown node:node /app tmp

USER node

CMD ["npm", "run", "dev"]
