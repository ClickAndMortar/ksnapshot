FROM mysql:8

RUN apt-get update \
    && apt-get install -y wget \
    && wget -q -O /usr/local/bin/osm https://cdn.appscode.com/binaries/osm/0.9.1/osm-linux-amd64 \
    && chmod +x /usr/local/bin/osm

COPY dump.sh /dump.sh

CMD ["/dump.sh"]
