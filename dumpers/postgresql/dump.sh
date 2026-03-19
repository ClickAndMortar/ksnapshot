#!/bin/bash

set -euo pipefail

POSTGRESQL_USERNAME_EFFECTIVE="${POSTGRESQL_USERNAME:-${POSTGRES_USER:-}}"
POSTGRESQL_PASSWORD_EFFECTIVE="${POSTGRESQL_PASSWORD:-${POSTGRES_PASSWORD:-}}"
POSTGRESQL_DATABASE_EFFECTIVE="${POSTGRESQL_DATABASE:-${POSTGRES_DB:-}}"

: "${POSTGRESQL_HOST:?POSTGRESQL_HOST is required}"
: "${POSTGRESQL_PORT:?POSTGRESQL_PORT is required}"
: "${POSTGRESQL_USERNAME_EFFECTIVE:?POSTGRESQL_USERNAME or POSTGRES_USER is required}"
: "${POSTGRESQL_PASSWORD_EFFECTIVE:?POSTGRESQL_PASSWORD or POSTGRES_PASSWORD is required}"
: "${POSTGRESQL_DATABASE_EFFECTIVE:?POSTGRESQL_DATABASE or POSTGRES_DB is required}"

cleanup_paths=()

cleanup() {
  for path in "${cleanup_paths[@]}"; do
    [[ -n "${path}" ]] && rm -rf "${path}"
  done
}

add_cleanup_path() {
  cleanup_paths+=("$1")
}

build_remote_prefix() {
  local path="${1:-}"
  path="${path#/}"
  path="${path%/}"

  if [[ -z "${path}" ]]; then
    printf ''
    return
  fi

  printf '/%s' "${path}"
}

configure_s3_context() {
  local s3_endpoint=""
  local -a osm_config_args

  osm_config_args=(ksnapshot --provider=s3)

  if [[ -n "${BACKEND_S3_REGION:-}" ]]; then
    s3_endpoint="https://s3.${BACKEND_S3_REGION}.amazonaws.com/"
    osm_config_args+=("--s3.region=${BACKEND_S3_REGION}")
  else
    s3_endpoint="${BACKEND_S3_ENDPOINT:-}"
  fi

  [[ -n "${s3_endpoint}" ]] && osm_config_args+=("--s3.endpoint=${s3_endpoint}")
  [[ -n "${BACKEND_S3_ACCESS_KEY:-}" ]] && osm_config_args+=("--s3.access_key_id=${BACKEND_S3_ACCESS_KEY}")
  [[ -n "${BACKEND_S3_SECRET_KEY:-}" ]] && osm_config_args+=("--s3.secret_key=${BACKEND_S3_SECRET_KEY}")

  osm config set-context "${osm_config_args[@]}"
}

trap cleanup EXIT

DUMP_NAME="dump-${HOSTNAME}-${POSTGRESQL_DATABASE_EFFECTIVE}-$(date +%Y%m%d%H%M%S).sql.gz"
DUMP_PATH="/tmp/${DUMP_NAME}"
add_cleanup_path "${DUMP_PATH}"

export PGPASSWORD="${POSTGRESQL_PASSWORD_EFFECTIVE}"

pg_dump_options=()

if [[ -n "${PG_DUMP_OPTIONS:-}" ]]; then
  read -r -a pg_dump_options <<< "${PG_DUMP_OPTIONS}"
fi

echo "Dumping database ${POSTGRESQL_DATABASE_EFFECTIVE} from server ${POSTGRESQL_HOST}:${POSTGRESQL_PORT}"

date_start="$(date +%s)"
last_report_at="${date_start}"

pg_dump \
  -h "${POSTGRESQL_HOST}" \
  -p "${POSTGRESQL_PORT}" \
  -U "${POSTGRESQL_USERNAME_EFFECTIVE}" \
  "${pg_dump_options[@]}" \
  "${POSTGRESQL_DATABASE_EFFECTIVE}" | gzip > "${DUMP_PATH}" &
dump_pid=$!

while kill -0 "${dump_pid}" 2>/dev/null; do
  current_time="$(date +%s)"

  if (( current_time - last_report_at >= 30 )) && [[ -f "${DUMP_PATH}" ]]; then
    dump_size_bytes="$(stat -c %s "${DUMP_PATH}")"
    dump_size_mb="$((dump_size_bytes / 1024 / 1024))"
    echo "Dump size: ${dump_size_mb}MB, duration: $((current_time - date_start)) seconds"
    last_report_at="${current_time}"
  fi

  sleep 1
done

wait "${dump_pid}"

echo "Dump available at: ${DUMP_PATH}"

if [[ "${ENCRYPTION_ENABLED:-false}" == "true" ]]; then
  : "${ENCRYPTION_RECIPIENT:?ENCRYPTION_RECIPIENT is required when encryption is enabled}"
  encrypted_dump_path="${DUMP_PATH}.age"
  age -r "${ENCRYPTION_RECIPIENT}" -o "${encrypted_dump_path}" "${DUMP_PATH}"
  add_cleanup_path "${encrypted_dump_path}"
  rm -f "${DUMP_PATH}"
  DUMP_NAME="${DUMP_NAME}.age"
  DUMP_PATH="${encrypted_dump_path}"
fi

if [[ "${BACKEND_TYPE:-}" == "s3" ]]; then
  : "${BACKEND_BUCKET:?BACKEND_BUCKET is required for s3 uploads}"

  remote_prefix="$(build_remote_prefix "${BACKEND_PATH:-}")"
  configure_s3_context

  osm push \
    --context ksnapshot \
    -c "${BACKEND_BUCKET}" \
    "${DUMP_PATH}" \
    "${remote_prefix}/$(date +%Y)/$(date +%m)/$(date +%d)/postgresql/${DUMP_NAME}"
fi
