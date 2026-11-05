#!/usr/bin/env bash
# The staging copy: one Cloud Run service with Cloud SQL (Postgres 17), in our one US region.
#
#   deploy/staging.sh setup    once per project: APIs, registry, database, secrets, service account
#   deploy/staging.sh deploy   every release: build, migrate, then deploy
#
# Needs the gcloud CLI, signed in (gcloud auth login), and these settings:
#   GOOGLE_CLOUD_PROJECT                   the Google Cloud project ID
#   GCP_REGION                             defaults to us-central1
#   SMTP_HOST, SMTP_USER, EMAIL_FROM       for deploy: where sign-in links are sent from
#   GOOGLE_OAUTH_CLIENT_ID                 optional: turns on Sign in with Google
set -euo pipefail

: "${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT to the Google Cloud project ID}"
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
    cloudbuild.googleapis.com secretmanager.googleapis.com --project "$PROJECT"

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

  cat <<EOF
Set up. Before the first deploy, add the SMTP password (and, for Sign in with Google, its client secret):
  printf '%s' 'the-smtp-password' | gcloud secrets create SMTP_PASSWORD --data-file - --project $PROJECT
  printf '%s' 'the-client-secret' | gcloud secrets create GOOGLE_OAUTH_CLIENT_SECRET --data-file - --project $PROJECT
EOF
}

deploy() {
  : "${SMTP_HOST:?Set SMTP_HOST}" "${SMTP_USER:?Set SMTP_USER}" "${EMAIL_FROM:?Set EMAIL_FROM}"
  local image project_number url env_vars secrets
  image="$REPOSITORY/bot-service:$(git rev-parse --short HEAD)"
  project_number="$(gcloud projects describe "$PROJECT" --format 'value(projectNumber)')"
  # Cloud Run's URL is fixed by the service name, so it is known before the first deploy.
  url="https://$SERVICE-$project_number.$REGION.run.app"

  env_vars="KOVOBOT_MODE=hosted,BILLING_ENABLED=false,PLAN_LIMITS_ENABLED=false,APP_URL=$url,API_URL=$url"
  env_vars="$env_vars,SMTP_HOST=$SMTP_HOST,SMTP_USER=$SMTP_USER,EMAIL_FROM=$EMAIL_FROM"
  secrets="DATABASE_URL=DATABASE_URL:latest,SESSION_SECRET=SESSION_SECRET:latest,SMTP_PASSWORD=SMTP_PASSWORD:latest"
  if [[ -n "${GOOGLE_OAUTH_CLIENT_ID:-}" ]]; then
    env_vars="$env_vars,GOOGLE_OAUTH_CLIENT_ID=$GOOGLE_OAUTH_CLIENT_ID"
    secrets="$secrets,GOOGLE_OAUTH_CLIENT_SECRET=GOOGLE_OAUTH_CLIENT_SECRET:latest"
  fi

  gcloud builds submit --tag "$image" --project "$PROJECT" .

  # Migrate before the new release serves; the previous release keeps working meanwhile.
  gcloud run jobs deploy "$SERVICE-migrate" --image "$image" --region "$REGION" --project "$PROJECT" \
    --command node --args apps/api/src/migrate.ts --service-account "$SERVICE_ACCOUNT" \
    --set-cloudsql-instances "$CLOUDSQL" --set-env-vars "$env_vars" --set-secrets "$secrets"
  gcloud run jobs execute "$SERVICE-migrate" --region "$REGION" --project "$PROJECT" --wait

  gcloud run deploy "$SERVICE" --image "$image" --region "$REGION" --project "$PROJECT" \
    --service-account "$SERVICE_ACCOUNT" --add-cloudsql-instances "$CLOUDSQL" \
    --set-env-vars "$env_vars" --set-secrets "$secrets" --allow-unauthenticated

  echo "Staging is live at $url"
}

case "${1:-}" in
  setup) setup ;;
  deploy) deploy ;;
  *) echo "Usage: deploy/staging.sh setup|deploy" >&2; exit 2 ;;
esac
