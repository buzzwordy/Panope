{{- define "panope.name" -}}{{ default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}{{- end -}}

{{- define "panope.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else -}}
{{ printf "%s-%s" .Release.Name (include "panope.name" .) | trunc 63 | trimSuffix "-" }}
{{- end -}}
{{- end -}}

{{- define "panope.labels" -}}
app.kubernetes.io/name: {{ include "panope.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "panope.selectorLabels" -}}
app.kubernetes.io/name: {{ include "panope.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "panope.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{ default (include "panope.fullname" .) .Values.serviceAccount.name }}
{{- else -}}
{{ default "default" .Values.serviceAccount.name }}
{{- end -}}
{{- end -}}
