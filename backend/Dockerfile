FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production DB_PATH=/app/data/plague.db
EXPOSE 8080
CMD ["node", "src/server.js"]
