FROM node:18 as builder

WORKDIR /app

COPY . /app/

RUN npm install \
    && node_modules/.bin/tsc

FROM node:18

ENV MODE=cluster

WORKDIR /app

COPY --from=builder /app/dist /app

CMD ["node", "index.js"]
