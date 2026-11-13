FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && npm install && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm run build && mkdir -p /app/data && chown -R node:node /app && chmod -R u+rwX,go+rX /app
USER node
ENV DATA_DIR=/app/data
EXPOSE 3001
VOLUME ["/app/data"]
CMD ["node", "server.js"]
