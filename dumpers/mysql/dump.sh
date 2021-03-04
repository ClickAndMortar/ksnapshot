#!/bin/bash

set -e
set -o pipefail

DUMP_NAME="dump-${MYSQL_DATABASE}-$(date +%Y%m%d%H%M).sql.gz"
DUMP_PATH="/tmp/${DUMP_NAME}"

MYSQLDUMP_OPTIONS="--no-tablespaces --single-transaction ${MYSQLDUMP_OPTIONS}"

echo "Dumping database ${MYSQL_DATABASE} from server ${MYSQL_HOST}:${MYSQL_PORT}"

mysqldump \
  -u ${MYSQL_USERNAME} \
  -p${MYSQL_PASSWORD} \
  -h ${MYSQL_HOST} \
  -P ${MYSQL_PORT} \
  ${MYSQLDUMP_OPTIONS} \
  ${MYSQL_DATABASE} | gzip > ${DUMP_PATH}

echo "Dump available at: ${DUMP_PATH}"

if [[ "${BACKEND_TYPE}" == "s3" ]]; then

    if [[ ! -z "${BACKEND_S3_REGION}" ]]; then
        S3_ENDPOINT="https://s3.${BACKEND_S3_REGION}.amazonaws.com/"
    else
        S3_ENDPOINT="${BACKEND_S3_ENDPOINT}"
    fi

    osm config set-context \
        ksnapshot --provider=s3 \
        --s3.access_key_id=${BACKEND_S3_ACCESS_KEY} --s3.secret_key=${BACKEND_S3_SECRET_KEY} --s3.endpoint=${S3_ENDPOINT}

    osm push --context ksnapshot -c ${BACKEND_BUCKET} ${DUMP_PATH} /$(echo ${BACKEND_PATH} | sed -r -e "s/\/$//g" -e "s/^\///g")/${DUMP_NAME}
fi
