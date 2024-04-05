FROM node:12

WORKDIR /app

ENV MODE=cluster

COPY package.json package-lock.json /app/

RUN npm install

COPY . /app/

CMD ["npm", "prod"]
