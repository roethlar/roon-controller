# ── Stage 1: Build backend ────────────────────────────────────────────────────
FROM node:22-alpine AS backend-build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
COPY src/ src/
RUN npm ci && npm run build

# ── Stage 2: Build frontend ──────────────────────────────────────────────────
FROM node:22-alpine AS frontend-build
WORKDIR /build
# Frontend needs src/shared for the @shared alias
COPY src/shared/ src/shared/
COPY ui/ ui/
WORKDIR /build/ui
RUN npm ci && npm run build

# ── Stage 3: Production runtime ──────────────────────────────────────────────
FROM node:22-alpine
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
