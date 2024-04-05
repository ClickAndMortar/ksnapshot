#!/bin/bash

set -e -o pipefail

DUMP_NAME="dump-${HOSTNAME}-${MYSQL_DATABASE}-$(date +%Y%m%d%H%M%S).sql.gz"
DUMP_PATH="/tmp/${DUMP_NAME}"

MYSQLDUMP_OPTIONS="--no-tablespaces --single-transaction ${MYSQLDUMP_OPTIONS}"

for TABLE in ${MYSQLDUMP_EXCLUDED_TABLES}; do
  MYSQLDUMP_OPTIONS="${MYSQLDUMP_OPTIONS} --ignore-table=${MYSQL_DATABASE}.${TABLE}"
done

echo "Dumping database ${MYSQL_DATABASE} from server ${MYSQL_HOST}:${MYSQL_PORT}"

DATE_START="$(date +%s)"

mysqldump \
  -u ${MYSQL_USERNAME} \
  -p${MYSQL_PASSWORD} \
  -h ${MYSQL_HOST} \
  -P ${MYSQL_PORT} \
  ${MYSQLDUMP_OPTIONS} \
  ${MYSQL_DATABASE} ${MYSQLDUMP_TABLES} | gzip > ${DUMP_PATH} &

while pgrep mysqldump > /dev/null
do
  # Show progress every 30 seconds
  if [[ "$(echo "$(date +%s)%30" | bc)" == "0" ]]; then
    echo -n "Dump size: $(echo "$(stat -c %s ${DUMP_PATH})/1024^2" | bc)MB, "
    echo "duration: $(echo "$(date +%s)-${DATE_START}" | bc) seconds"
  fi
  sleep 1
done

echo "Dump available at: ${DUMP_PATH}"

if [[ "${ENCRYPTION_ENABLED}" == "true" ]]; then
  age -r ${ENCRYPTION_RECIPIENT} -o ${DUMP_PATH}.age ${DUMP_PATH}
  DUMP_NAME="${DUMP_NAME}.age"
  DUMP_PATH="${DUMP_PATH}.age"
fi

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

    osm push --context ksnapshot -c ${BACKEND_BUCKET} ${DUMP_PATH} /$(echo ${BACKEND_PATH} | sed -r -e "s/\/$//g" -e "s/^\///g")/$(date +%Y)/$(date +%m)/$(date +%d)/${DUMP_NAME}
fi

rm -f ${DUMP_PATH}
