FROM node:18 as builder

WORKDIR /app

COPY . /app/

RUN npm install \
    && tsc

FROM node:18

ENV MODE=cluster

WORKDIR /app

COPY --from=builder /app/dist /app

CMD ["node", "index.js"]
