#!/bin/bash

set -e -o pipefail

DUMP_PREFIX="dump-${HOSTNAME}-$(date +%Y%m%d%H%M)"
DUMP_SUFFIX=".jsonl.gz"
DUMP_DIRECTORY="/tmp/dumps"

mkdir -p ${DUMP_DIRECTORY}

ELASTICDUMP_OPTIONS="--fsCompress --limit 500 ${ELASTICDUMP_OPTIONS}"
ELASTICDUMP_TYPES="index settings analyzer data mapping policy alias template"

ELASTICSEARCH_URL="http://${ELASTICSEARCH_HOST}:${ELASTICSEARCH_PORT}"
ELASTICSEARCH_VERSION="$(curl -sSL ${ELASTICSEARCH_URL} | jq -r ".version.number")"

if semver -r ">=6.6.0" ${ELASTICSEARCH_VERSION}; then
  ELASTICDUMP_TYPES="policy ${ELASTICDUMP_TYPES}"
fi

if semver -r ">=7.8.0" ${ELASTICSEARCH_VERSION}; then
  ELASTICDUMP_TYPES="index_template component_template ${ELASTICDUMP_TYPES}"
fi

for TYPE in ${ELASTICDUMP_TYPES}; do
    echo "Dumping type [${TYPE}]..."
    elasticdump \
        --input=${ELASTICSEARCH_URL} \
        --output=${DUMP_DIRECTORY}/${DUMP_PREFIX}-${TYPE}${DUMP_SUFFIX} \
        --type=${TYPE} \
        ${ELASTICDUMP_OPTIONS} || true # Avoid failure due to set -e

    echo "Dumping type [${TYPE}]... Done"
done

if [[ "${BACKEND_TYPE}" == "s3" ]]; then
    OSM_CONFIG_ARGS=""
    if [[ ! -z "${BACKEND_S3_REGION}" ]]; then
        S3_ENDPOINT="https://s3.${BACKEND_S3_REGION}.amazonaws.com/"
        OSM_CONFIG_ARGS="--s3.region=${BACKEND_S3_REGION}"
    else
        S3_ENDPOINT="${BACKEND_S3_ENDPOINT}"
    fi

    osm config set-context \
        ksnapshot --provider=s3 \
        --s3.access_key_id=${BACKEND_S3_ACCESS_KEY} --s3.secret_key=${BACKEND_S3_SECRET_KEY} \
        --s3.endpoint=${S3_ENDPOINT} ${OSM_CONFIG_ARGS}

    osm push --context ksnapshot -c ${BACKEND_BUCKET} ${DUMP_DIRECTORY}/ /$(echo ${BACKEND_PATH} | sed -r -e "s/\/$//g" -e "s/^\///g")/$(date +%Y)/$(date +%m)/$(date +%d)/elasticsearch/
fi

rm -rf ${DUMP_DIRECTORY}
