#!/usr/bin/env bash
# The staging copy: one Cloud Run service with Cloud SQL (Postgres 17), in our one US region.
#
#   deploy/staging.sh setup    once per project: APIs, registry, database, secrets, service account
#   deploy/staging.sh deploy   every release: build, migrate, then deploy
#   deploy/staging.sh run …    one of the API's commands, e.g. run customers-add someone@example.com
#
# Needs the gcloud CLI, signed in (gcloud auth login), and these settings, taken
# from the command line or else from .env:
#   GOOGLE_CLOUD_PROJECT                   the Google Cloud project ID
#   GCP_REGION                             defaults to us-central1
#   SMTP_HOST, SMTP_PORT, SMTP_USER, EMAIL_FROM, SMTP_PASSWORD
#                                          where sign-in links are sent from; setup
#                                          stores SMTP_PASSWORD in Secret Manager
#   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
#                                          optional: turn on Sign in with Google
#   ANTHROPIC_WORKSPACE_ID                 for an Anthropic key not scoped to a workspace (optional)
#   OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY
#                                          our Model provider keys; deploy stores each one set
#   LANDING_URL                            optional: the landing page that posts leads,
#                                          e.g. https://kovobot.com
#   COMPOSIO_API_KEY                       optional: our Composio project key (ak_...), for
#                                          Connected apps; deploy stores it like the others
# deploy also makes SWEEP_KEY, and the Cloud Scheduler job that runs the sweeps with it.
set -euo pipefail

# Settings not given on the command line come from .env. Values are never printed.
if [[ -f .env ]]; then
  while IFS='=' read -r name value; do
    [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
    [[ -n "${!name:-}" ]] && continue
    value="${value%$'\r'}"
    value="${value%\"}"
    value="${value#\"}"
    [[ -n "$value" ]] && export "$name=$value"
  done < .env
fi

# gcloud from PATH or, failing that, the Cloud SDK's per-user install on Windows,
# run straight from its bundled Python with -S, which that Python needs.
if ! command -v gcloud >/dev/null 2>&1; then
  CLOUD_SDK="${LOCALAPPDATA:-}/Google/Cloud SDK/google-cloud-sdk"
  if [[ -f "$CLOUD_SDK/lib/gcloud.py" && -f "$CLOUD_SDK/platform/bundledpython/python.exe" ]]; then
    export CLOUDSDK_PYTHON="$CLOUD_SDK/platform/bundledpython/python.exe"
    gcloud() { "$CLOUDSDK_PYTHON" -S "$CLOUD_SDK/lib/gcloud.py" "$@"; }
  else
    echo "The gcloud CLI isn't installed: https://cloud.google.com/sdk/docs/install" >&2
    exit 1
  fi
fi

: "${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT (in .env or on the command line) to the Google Cloud project ID}"
PROJECT="$GOOGLE_CLOUD_PROJECT"
REGION="${GCP_REGION:-us-central1}"
SERVICE="kovobot-staging"
DB_INSTANCE="kovobot-staging"
SERVICE_ACCOUNT="kovobot-staging@$PROJECT.iam.gserviceaccount.com"
REPOSITORY="$REGION-docker.pkg.dev/$PROJECT/kovobot"
CLOUDSQL="$PROJECT:$REGION:$DB_INSTANCE"

# Grants a project role, retrying while a just-created service account propagates.
grant() {
  local member="$1" role="$2" attempt
  for attempt in 1 2 3 4 5 6; do
    if gcloud projects add-iam-policy-binding "$PROJECT" --member "$member" --role "$role" --condition None >/dev/null; then
      return 0
    fi
    echo "Waiting for $member to exist (attempt $attempt)..." >&2
    sleep 10
  done
  return 1
}

setup() {
  gcloud services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
    cloudbuild.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com --project "$PROJECT"

  gcloud artifacts repositories create kovobot --repository-format docker --location "$REGION" --project "$PROJECT"

  gcloud sql instances create "$DB_INSTANCE" --database-version POSTGRES_17 --edition enterprise \
    --tier db-f1-micro --region "$REGION" --project "$PROJECT"
  gcloud sql databases create kovobot --instance "$DB_INSTANCE" --project "$PROJECT"
  local db_password
  db_password="$(openssl rand -hex 24)"
  gcloud sql users create kovobot --instance "$DB_INSTANCE" --password "$db_password" --project "$PROJECT"

  gcloud iam service-accounts create kovobot-staging --project "$PROJECT"
  for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
    grant "serviceAccount:$SERVICE_ACCOUNT" "$role"
  done
  # New projects run Cloud Build as the Compute Engine default service account,
  # which needs the builder role to read the uploaded source and push the image.
  local project_number
  project_number="$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')"
  grant "serviceAccount:$project_number-compute@developer.gserviceaccount.com" roles/cloudbuild.builds.builder

  # Cloud Run reaches Cloud SQL through a Unix socket under /cloudsql.
  printf 'postgres://kovobot:%s@/kovobot?host=/cloudsql/%s' "$db_password" "$CLOUDSQL" |
    gcloud secrets create DATABASE_URL --data-file - --project "$PROJECT"
  openssl rand -base64 32 | tr -d '\n' | gcloud secrets create SESSION_SECRET --data-file - --project "$PROJECT"
  store_secret SMTP_PASSWORD
  [[ -n "${GOOGLE_OAUTH_CLIENT_SECRET:-}" ]] && store_secret GOOGLE_OAUTH_CLIENT_SECRET
  echo "Set up. Next: deploy/staging.sh deploy"
}

# Stores a secret from the environment unless Secret Manager already holds that value.
sync_secret() {
  local name="$1" current
  [[ -n "${!name:-}" ]] || return 0
  current="$(gcloud secrets versions access latest --secret "$name" --project "$PROJECT" 2>/dev/null || true)"
  [[ "$current" == "${!name}" ]] || store_secret "$name"
}

# Makes a random secret the first time; later deploys use it as it is.
generated_secret() {
  local name="$1"
  gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1 && return 0
  openssl rand -base64 32 | tr -d '\n' | gcloud secrets create "$name" --data-file - --project "$PROJECT"
}

# Cloud Scheduler runs the service's sweeps (due schedules) once a minute. On Cloud Run the
# service has CPU only while a request is open, so it keeps no clock of its own (SWEEP_KEY).
# The sweep answers once its firings are done, so the deadline is Cloud Scheduler's longest.
sweep_job() {
  local url="$1" job="$SERVICE-sweep" key
  key="$(gcloud secrets versions access latest --secret SWEEP_KEY --project "$PROJECT")"
  local common=(--location "$REGION" --project "$PROJECT" --schedule "* * * * *" --time-zone Etc/UTC
    --uri "$url/api/sweep" --http-method POST --attempt-deadline 30m)
  if gcloud scheduler jobs describe "$job" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$job" "${common[@]}" --update-headers "x-sweep-key=$key" >/dev/null
  else
    gcloud scheduler jobs create http "$job" "${common[@]}" --headers "x-sweep-key=$key" >/dev/null
  fi
  echo "Cloud Scheduler sweeps $url once a minute ($job)."
}

# Copies a secret from the environment (.env) into Secret Manager, or adds a new version of it.
store_secret() {
  local name="$1"
  : "${!name:?Set $name in .env first}"
  if gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    printf '%s' "${!name}" | gcloud secrets versions add "$name" --data-file - --project "$PROJECT"
  else
    printf '%s' "${!name}" | gcloud secrets create "$name" --data-file - --project "$PROJECT"
  fi
}

deploy() {
  : "${SMTP_HOST:?Set SMTP_HOST}" "${SMTP_USER:?Set SMTP_USER}" "${EMAIL_FROM:?Set EMAIL_FROM}"
  local image project_number url env_vars secrets
  image="$REPOSITORY/bot-service:$(git rev-parse --short HEAD)"
  project_number="$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')"
  # Cloud Run's URL is fixed by the service name, so it is known before the first deploy.
  url="https://$SERVICE-$project_number.$REGION.run.app"

  env_vars="KOVOBOT_MODE=hosted,BILLING_ENABLED=false,PLAN_LIMITS_ENABLED=false,APP_URL=$url,API_URL=$url"
  env_vars="$env_vars,SMTP_HOST=$SMTP_HOST,SMTP_PORT=${SMTP_PORT:-587},SMTP_USER=$SMTP_USER,EMAIL_FROM=$EMAIL_FROM"
  [[ -n "${LANDING_URL:-}" ]] && env_vars="$env_vars,LANDING_URL=$LANDING_URL"
  [[ -n "${ANTHROPIC_WORKSPACE_ID:-}" ]] && env_vars="$env_vars,ANTHROPIC_WORKSPACE_ID=$ANTHROPIC_WORKSPACE_ID"
  secrets="DATABASE_URL=DATABASE_URL:latest,SESSION_SECRET=SESSION_SECRET:latest,SMTP_PASSWORD=SMTP_PASSWORD:latest"
  if [[ -n "${GOOGLE_OAUTH_CLIENT_ID:-}" ]]; then
    env_vars="$env_vars,GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_OAUTH_CLIENT_ID"
    secrets="$secrets,GOOGLE_OAUTH_CLIENT_SECRET=GOOGLE_OAUTH_CLIENT_SECRET:latest"
  fi
  # The SMTP password follows .env, so fixing it there and deploying is enough.
  sync_secret SMTP_PASSWORD
  # The key Cloud Scheduler's ticks carry; made once.
  gcloud services enable cloudscheduler.googleapis.com --project "$PROJECT"
  generated_secret SWEEP_KEY
  secrets="$secrets,SWEEP_KEY=SWEEP_KEY:latest"

  # Each Model provider key set in .env goes to Secret Manager (a new version only
  # when it changed) and to the service; Bots can use that Model provider's models.
  local key
  for key in OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY XAI_API_KEY OPENROUTER_API_KEY; do
    # Set in .env: stored first. Already in Secret Manager: used as it is.
    sync_secret "$key"
    gcloud secrets describe "$key" --project "$PROJECT" >/dev/null 2>&1 && secrets="$secrets,$key=$key:latest"
  done

  # Connected apps: our Composio project key, set in .env, the same way. A Composio Connect
  # consumer key (ck_...) is for one person's apps in an MCP client, and Composio's platform API
  # refuses it, so it isn't deployed.
  if [[ "${COMPOSIO_API_KEY:-}" == ck_* ]]; then
    echo "COMPOSIO_API_KEY is a Composio Connect consumer key (ck_...): Connected apps stay off. Put a project API key (ak_...) in .env." >&2
  elif [[ -n "${COMPOSIO_API_KEY:-}" ]] || gcloud secrets describe COMPOSIO_API_KEY --project "$PROJECT" >/dev/null 2>&1; then
    sync_secret COMPOSIO_API_KEY
    secrets="$secrets,COMPOSIO_API_KEY=COMPOSIO_API_KEY:latest"
  fi

  gcloud builds submit --tag "$image" --project "$PROJECT" .

  # One job runs the API's commands with the service's own settings. Migrations
  # go first; the previous release keeps serving meanwhile.
  gcloud run jobs deploy "$SERVICE-command" --image "$image" --region "$REGION" --project "$PROJECT" \
    --command node --args apps/api/src/migrate.ts --service-account "$SERVICE_ACCOUNT" \
    --set-cloudsql-instances "$CLOUDSQL" --set-env-vars "$env_vars" --set-secrets "$secrets"
  gcloud run jobs execute "$SERVICE-command" --region "$REGION" --project "$PROJECT" --wait

  # A reply streams for as long as its Task runs, a Computer take-over included, and so does a
  # sweep: an hour, Cloud Run's longest, rather than its default five minutes.
  gcloud run deploy "$SERVICE" --image "$image" --region "$REGION" --project "$PROJECT" \
    --service-account "$SERVICE_ACCOUNT" --add-cloudsql-instances "$CLOUDSQL" \
    --set-env-vars "$env_vars" --set-secrets "$secrets" --allow-unauthenticated --timeout 3600

  sweep_job "$url"
  echo "Staging is live at $url"
}

# Runs one of the API's commands (apps/api/src/cli/<name>.ts) against staging, e.g.
#   deploy/staging.sh run customers-add someone@example.com
# Its output is in the job's logs, linked from the execution.
run_command() {
  local name="${1:?Usage: deploy/staging.sh run <command> [arguments...]}"
  shift
  local args="apps/api/src/cli/$name.ts"
  for arg in "$@"; do args="$args,$arg"; done
  gcloud run jobs execute "$SERVICE-command" --region "$REGION" --project "$PROJECT" --args "$args" --wait
}

case "${1:-}" in
  setup) setup ;;
  deploy) deploy ;;
  run) shift; run_command "$@" ;;
  *) echo "Usage: deploy/staging.sh setup|deploy|run <command> [arguments...]" >&2; exit 2 ;;
esac
