FROM node:12

WORKDIR /app

ENV MODE=cluster

COPY package.json yarn.lock /app/

RUN yarn install

COPY . /app/

CMD ["yarn", "prod"]
