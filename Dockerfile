# gas-oracle-x402 — minimal Node 22 image (Render injects PORT).
FROM node:22-alpine

WORKDIR /app

# npm ci requires package-lock.json (committed). devDependencies are kept
# because `npm start` runs through tsx.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/healthz" >/dev/null 2>&1 || exit 1

CMD ["npm", "start"]
