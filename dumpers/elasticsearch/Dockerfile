FROM node:18

RUN apt-get update \
    && apt-get install -y wget procps bc \
    && wget -q -O /usr/local/bin/osm https://github.com/appscode/osm/releases/download/v0.14.0/osm-linux-amd64 \
    && chmod +x /usr/local/bin/osm

RUN npm install -g elasticdump@^6.10.0 semver@^7.6.0

RUN wget -q https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64 -O /usr/local/bin/jq \
    && chmod +x /usr/local/bin/jq

COPY /dumpers/elasticsearch/dump.sh /dump.sh

CMD ["/dump.sh"]
