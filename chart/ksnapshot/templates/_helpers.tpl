{{/*
Expand the name of the chart.
*/}}
{{- define "ksnapshot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "ksnapshot.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "ksnapshot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "ksnapshot.labels" -}}
helm.sh/chart: {{ include "ksnapshot.chart" . }}
{{ include "ksnapshot.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "ksnapshot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ksnapshot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use.
*/}}
{{- define "ksnapshot.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "ksnapshot.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Create the name of the backup-job service account to use.
*/}}
{{- define "ksnapshot.backupJobServiceAccountName" -}}
{{- if .Values.backupJob.serviceAccount.create }}
{{- default (printf "%s-backup" (include "ksnapshot.fullname" .)) .Values.backupJob.serviceAccount.name }}
{{- else }}
{{- default (printf "%s-backup" (include "ksnapshot.fullname" .)) .Values.backupJob.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Create the configmap name used by backup jobs.
*/}}
{{- define "ksnapshot.configMapName" -}}
{{- if .Values.existingConfigMap -}}
{{- .Values.existingConfigMap -}}
{{- else -}}
ksnapshot-cm
{{- end -}}
{{- end }}

{{/*
Create the secret name used by backup jobs.
*/}}
{{- define "ksnapshot.secretName" -}}
{{- if .Values.secret.create -}}
ksnapshot-secret
{{- else -}}
{{- .Values.existingSecret -}}
{{- end -}}
{{- end }}

{{/*
Resolve the full image reference for a dumper.
*/}}
{{- define "ksnapshot.defaultImageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag }}
{{- end }}

{{- define "ksnapshot.mysql57Image" -}}
{{- if .Values.dumperImages.mysql.v5_7 -}}
{{- .Values.dumperImages.mysql.v5_7 -}}
{{- else -}}
{{- printf "ghcr.io/clickandmortar/ksnapshot-dumper-mysql-5.7:%s" (include "ksnapshot.defaultImageTag" .) -}}
{{- end -}}
{{- end }}

{{- define "ksnapshot.mysql8Image" -}}
{{- if .Values.dumperImages.mysql.v8 -}}
{{- .Values.dumperImages.mysql.v8 -}}
{{- else -}}
{{- printf "ghcr.io/clickandmortar/ksnapshot-dumper-mysql-8:%s" (include "ksnapshot.defaultImageTag" .) -}}
{{- end -}}
{{- end }}

{{- define "ksnapshot.postgresql16Image" -}}
{{- if .Values.dumperImages.postgresql.v16 -}}
{{- .Values.dumperImages.postgresql.v16 -}}
{{- else -}}
{{- printf "ghcr.io/clickandmortar/ksnapshot-dumper-postgresql-16:%s" (include "ksnapshot.defaultImageTag" .) -}}
{{- end -}}
{{- end }}

{{- define "ksnapshot.elasticsearchImage" -}}
{{- if .Values.dumperImages.elasticsearch -}}
{{- .Values.dumperImages.elasticsearch -}}
{{- else -}}
{{- printf "ghcr.io/clickandmortar/ksnapshot-dumper-elasticsearch:%s" (include "ksnapshot.defaultImageTag" .) -}}
{{- end -}}
{{- end }}
