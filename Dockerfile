# ---- Fase 1: dependências ------------------------------------------------
# Usa uma imagem completa para compilar better-sqlite3 caso não haja binário
# pré-compilado para a arquitectura do VPS (ex.: ARM).
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Fase 2: runtime -----------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_FILE=/data/viagem.db

RUN apt-get update \
 && apt-get install -y --no-install-recommends wget \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY views ./views
COPY public ./public

# Pasta persistente da base de dados (montada como volume)
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 3000

# Segue a variável PORT: painéis como o Coolify injectam a porta deles, e um
# valor fixo aqui faria o healthcheck sondar uma porta onde a app não escuta.
# Forma shell (sem JSON) para o ${PORT} ser expandido em cada execução.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --spider -q "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "src/server.js"]
