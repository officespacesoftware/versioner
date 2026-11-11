#!/bin/bash
# Build and deploy the Slack app to Cloud Run.
#   deploy.sh <channel ids> <approver ids>   (comma-separated Slack IDs)
set -euo pipefail

P=oss-development-323115
R=us-central1
SA=release-manager@$P.iam.gserviceaccount.com
URL=https://release-manager-6rhxlxxchq-uc.a.run.app
HERE=$(cd "$(dirname "$0")" && pwd)
PKG=$(dirname "$HERE")
CHANNELS=${1:?channel ids}
APPROVERS=${2:?approver ids}

ENV_FILE=$(mktemp)
trap 'rm -f "$ENV_FILE"' EXIT
python3 - "$ENV_FILE" "$HERE/agent-setup-test.md" "$CHANNELS" "$APPROVERS" "$URL" "$SA" "$P" "$R" <<'PY'
import json, sys
out, setup, channels, approvers, url, sa, p, r = sys.argv[1:]
env = {
  "SLACK_CHANNELS": channels,
  "APPROVERS": approvers,
  "CURSOR_REPOS": "https://github.com/officespacesoftware/release-management-test,https://github.com/officespacesoftware/versioner",
  "CURSOR_MODEL": "claude-sonnet-5-5",
  "GITHUB_REPO_URL": "https://github.com/officespacesoftware/release-management-test",
  "AGENT_SETUP": open(setup).read(),
  "TASKS_QUEUE": f"projects/{p}/locations/{r}/queues/release-manager",
  "SERVICE_URL": url,
  "TASK_SERVICE_ACCOUNT": sa,
}
with open(out, "w") as f:
  for k, v in env.items():
    f.write(f"{k}: {json.dumps(v)}\n")
PY

(cd "$PKG" && npx tsc)
gcloud run deploy release-manager --project $P --region $R \
  --source "$PKG" \
  --service-account $SA \
  --env-vars-file "$ENV_FILE" \
  --set-secrets "CURSOR_API_KEY=release-manager-cursor-api-key:latest,SLACK_SIGNING_SECRET=release-manager-slack-signing-secret:latest,SLACK_BOT_TOKEN=release-manager-slack-bot-token:latest" \
  --min-instances 0 --max-instances 3 --memory 256Mi --timeout 60

gcloud run services describe release-manager --project $P --region $R \
  --format "value(status.url)"
