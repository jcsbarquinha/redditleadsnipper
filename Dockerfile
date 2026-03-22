# Leadsnipe API — Node 20 + SQLite (persist /data in production)
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm rebuild better-sqlite3
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir -p /data
ENV DATABASE_URL=/data/reddit-leads.db
# Render injects PORT at runtime; image default helps local `docker run` without -e PORT
ENV PORT=10000
EXPOSE 10000
# Run as root so a Render Disk mounted at /data is writable (volume often root-owned; node user could block SQLite)
CMD ["node", "dist/server.js"]
