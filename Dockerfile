FROM node:22.23.4-slim AS builder

WORKDIR /app

COPY . /app/

RUN npm install \
    && node_modules/.bin/tsc

FROM node:22.23.4-slim

ENV MODE=cluster
ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder /app/dist /app
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/package-lock.json /app/package-lock.json

RUN npm install --omit=dev

CMD ["node", "index.js"]
