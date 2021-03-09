FROM mysql:5.7

RUN apt-get update \
    && apt-get install -y wget procps bc \
    && wget -q -O /usr/local/bin/osm https://cdn.appscode.com/binaries/osm/0.9.1/osm-linux-amd64 \
    && chmod +x /usr/local/bin/osm

RUN wget -q https://github.com/FiloSottile/age/releases/download/v1.0.0-beta7/age-v1.0.0-beta7-linux-amd64.tar.gz -O /tmp/age.tgz \
    && tar -C /usr/local/bin/ --strip-components=1 -zxf /tmp/age.tgz age/age

COPY dump.sh /dump.sh

CMD ["/dump.sh"]
