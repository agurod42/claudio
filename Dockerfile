FROM node:22-bookworm

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN corepack pnpm install --frozen-lockfile

COPY src ./src

CMD ["node", "--import", "tsx", "src/deploy/server.ts"]
