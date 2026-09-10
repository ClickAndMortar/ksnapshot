#!/bin/bash

set -euo pipefail

export HOME=/tmp

: "${ELASTICSEARCH_HOST:?ELASTICSEARCH_HOST is required}"
: "${ELASTICSEARCH_PORT:?ELASTICSEARCH_PORT is required}"

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

DUMP_PREFIX="dump-${HOSTNAME}-$(date +%Y%m%d%H%M)"
DUMP_SUFFIX=".jsonl.gz"
DUMP_DIRECTORY="/tmp/dumps"
add_cleanup_path "${DUMP_DIRECTORY}"

mkdir -p "${DUMP_DIRECTORY}"

elasticdump_types=(index settings analyzer data mapping alias template)
ELASTICDUMP_LIMIT="${ELASTICDUMP_LIMIT:-1000}"

ELASTICSEARCH_URL="http://${ELASTICSEARCH_HOST}:${ELASTICSEARCH_PORT}"
ELASTICSEARCH_VERSION="$(curl -fsSL "${ELASTICSEARCH_URL}" | jq -r '.version.number')"

if semver -r '>=6.6.0' "${ELASTICSEARCH_VERSION}"; then
  elasticdump_types=(policy "${elasticdump_types[@]}")
fi

if semver -r '>=7.8.0' "${ELASTICSEARCH_VERSION}"; then
  elasticdump_types=(index_template component_template "${elasticdump_types[@]}")
fi

# Cluster metadata types that may legitimately not exist on a given instance.
# elasticdump exits non-zero (404 index_not_found_exception on "undefined") when
# asked for e.g. aliases on a cluster that defines none. Losing an empty alias
# list must not invalidate a snapshot whose data and mappings already dumped.
optional_types=(alias template policy index_template component_template)

is_optional_type() {
  local candidate="$1"
  local known
  for known in "${optional_types[@]}"; do
    [[ "${known}" == "${candidate}" ]] && return 0
  done
  return 1
}

skipped_types=()

for type in "${elasticdump_types[@]}"; do
  echo "Dumping type [${type}]..."

  status=0
  elasticdump \
    --input="${ELASTICSEARCH_URL}" \
    --output="${DUMP_DIRECTORY}/${DUMP_PREFIX}-${type}${DUMP_SUFFIX}" \
    --type="${type}" \
    --noRefresh \
    --fsCompress \
    --limit="${ELASTICDUMP_LIMIT}" || status=$?

  if [[ "${status}" -eq 0 ]]; then
    echo "Dumping type [${type}]... Done"
    continue
  fi

  if ! is_optional_type "${type}"; then
    echo "Dumping type [${type}]... FAILED (elasticdump exited ${status})" >&2
    exit "${status}"
  fi

  # Drop the partial artifact so a truncated file is never pushed to S3.
  rm -f "${DUMP_DIRECTORY}/${DUMP_PREFIX}-${type}${DUMP_SUFFIX}"
  skipped_types+=("${type}")
  echo "Dumping type [${type}]... SKIPPED (elasticdump exited ${status}, optional type)" >&2
done

if [[ "${#skipped_types[@]}" -gt 0 ]]; then
  echo "Optional types skipped: ${skipped_types[*]}" >&2
fi

if [[ "${ENCRYPTION_ENABLED:-false}" == "true" ]]; then
  : "${ENCRYPTION_RECIPIENT:?ENCRYPTION_RECIPIENT is required when encryption is enabled}"

  while IFS= read -r dump_file; do
    age -r "${ENCRYPTION_RECIPIENT}" -o "${dump_file}.age" "${dump_file}"
    rm -f "${dump_file}"
  done < <(find "${DUMP_DIRECTORY}" -type f -name '*.jsonl.gz' -print)
fi

if [[ "${BACKEND_TYPE:-}" == "s3" ]]; then
  : "${BACKEND_BUCKET:?BACKEND_BUCKET is required for s3 uploads}"

  remote_prefix="$(build_remote_prefix "${BACKEND_PATH:-}")"
  configure_s3_context

  osm push \
    --context ksnapshot \
    -c "${BACKEND_BUCKET}" \
    "${DUMP_DIRECTORY}/" \
    "${remote_prefix}/$(date +%Y)/$(date +%m)/$(date +%d)/elasticsearch/"
fi
