# ── Stage 1: Build backend ────────────────────────────────────────────────────
FROM node:22-alpine AS backend-build
# The Roon dependencies are pulled directly from GitHub via git URLs
# (Roon Labs doesn't publish them to npm). `npm ci` shells out to `git`
# to fetch them, so the stripped node:22-alpine base — which has no git —
# fails the install without this.
RUN apk add --no-cache git
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
COPY src/ src/
RUN npm ci && npm run build

# ── Stage 2: Build frontend ──────────────────────────────────────────────────
FROM node:22-alpine AS frontend-build
WORKDIR /build
# Frontend has no Roon deps, so no git is needed.
COPY src/shared/ src/shared/
COPY ui/ ui/
WORKDIR /build/ui
RUN npm ci && npm run build

# ── Stage 3: Production runtime ──────────────────────────────────────────────
FROM node:22-alpine
# Same reason: production install of Roon deps needs git.
RUN apk add --no-cache git
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=backend-build /build/dist/ dist/
COPY --from=frontend-build /build/ui/build/ ui/build/

RUN mkdir -p config data/image-cache

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3333

EXPOSE 3333

CMD ["node", "dist/index.js"]
