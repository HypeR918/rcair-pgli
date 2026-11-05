#!/usr/bin/env bash
# Node → Python → Node через тот же Nginx; только локальные MAX API и тестовый TLS.
set -euo pipefail
bot_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d /tmp/rcair-python-smoke.XXXXXX)"
project="rcair-python-smoke-$$"
export RCAIR_SMOKE_BOT_DIR="$bot_dir" RCAIR_SMOKE_TEST_DIR="$test_dir"
export MAX_BOT_NGINX_CONF="$bot_dir/deploy/nginx.docker.conf"
export MAX_BOT_TLS_DIR="$test_dir"
export MAX_BOT_NGINX_CONTAINER_NAME="$project-nginx"
export MAX_BOT_BIND_IP=127.0.0.1 MAX_BOT_HTTP_PORT=0 MAX_BOT_HTTPS_PORT=0
export MAX_BOT_PYTHON_CONTEXT="$bot_dir/python_webhook"
base=(-p "$project" --env-file /dev/null -f "$test_dir/base.yml" -f "$bot_dir/deploy/docker-compose.nginx.yml")
node_compose() { docker compose "${base[@]}" "$@"; }
py_compose() { docker compose "${base[@]}" -f "$bot_dir/deploy/docker-compose.python.yml" -f "$test_dir/python.yml" "$@"; }
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then py_compose logs --tail 30 >&2 || true; fi
  py_compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$test_dir"
  exit "$result"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=botsupport.gov70.ru \
  -addext subjectAltName=DNS:botsupport.gov70.ru,DNS:max-api \
  -keyout "$test_dir/privkey.pem" -out "$test_dir/fullchain.pem" 2>/dev/null
chmod 644 "$test_dir/fullchain.pem"
cat > "$test_dir/base.yml" <<'YAML'
services:
  max-api:
    image: max-glpi-bot:python-webhook
    user: "0:0"
    command: ["python", "/test/smoke_api.py"]
    environment:
      SSL_CERT_FILE: /test-ca.pem
    volumes:
      - ${RCAIR_SMOKE_BOT_DIR}/python_webhook/smoke_api.py:/test/smoke_api.py:ro
      - ${RCAIR_SMOKE_TEST_DIR}/fullchain.pem:/test-ca.pem:ro
      - ${RCAIR_SMOKE_TEST_DIR}/privkey.pem:/test-key.pem:ro
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.build_opener(urllib.request.ProxyHandler({})).open('https://max-api:3001/me', timeout=3)"]
      interval: 1s
      timeout: 4s
      retries: 20
  max-bot:
    image: node:22-bookworm-slim
    command: ["node", "/source/test/helpers/docker-webhook.mjs"]
    environment:
      BOT_TOKEN: offline-token
      WEBHOOK_SECRET: offline-webhook-secret
      WEBHOOK_URL: https://botsupport.gov70.ru/max/callback/
      PYTHON_MAX_TIMEOUT_SECONDS: "0.3"
      SSL_CERT_FILE: /test-ca.pem
      NO_PROXY: 127.0.0.1,localhost,max-api,nginx,max-bot
      no_proxy: 127.0.0.1,localhost,max-api,nginx,max-bot
    volumes:
      - ${RCAIR_SMOKE_BOT_DIR}:/source:ro
      - ${RCAIR_SMOKE_TEST_DIR}/fullchain.pem:/test-ca.pem:ro
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 1s
      timeout: 4s
      retries: 20
YAML
cat > "$test_dir/python.yml" <<'YAML'
services:
  max-bot:
    command: ["python", "-c", "import os; from aiohttp import web; from app import Config, create_app; web.run_app(create_app(Config.from_env(os.environ), api_url='https://max-api:3001'), port=3000, access_log=None)"]
YAML
node_compose up -d --wait --wait-timeout 90
nginx_id="$(node_compose ps -q nginx)"
https_port="$(node_compose port nginx 443)"; https_port="${https_port##*:}"
request() {
  curl --noproxy botsupport.gov70.ru --silent --show-error --cacert "$test_dir/fullchain.pem" \
    --resolve "botsupport.gov70.ru:$https_port:127.0.0.1" --connect-timeout 2 --max-time 4 \
    -o "$test_dir/response" -w '%{http_code}' "$@" "https://botsupport.gov70.ru:$https_port/max/callback/"
}
deliver() {
  request -H 'Content-Type: application/json' -H 'X-Max-Bot-Api-Secret: offline-webhook-secret' \
    --data-binary "{\"update_type\":\"message_created\",\"timestamp\":1,\"message\":{\"sender\":{\"user_id\":123,\"is_bot\":false},\"recipient\":{\"chat_id\":456,\"chat_type\":\"dialog\"},\"body\":{\"mid\":\"$1\",\"text\":\"/start\",\"attachments\":[]}}}"
}
[ "$(deliver node.before)" = 200 ]
py_compose up -d --no-deps --no-build --force-recreate --wait --wait-timeout 90 max-bot
for attempt in $(seq 1 12); do
  if [ "$(deliver python.first)" = 200 ]; then break; fi
  sleep 1
done
[ "$(deliver python.first)" = 200 ]
[ "$(request --head)" = 403 ]
[ "$(request -H 'Content-Type: application/json' --data-binary '{}')" = 403 ]
[ "$(request -H 'Content-Type: application/json' -H 'X-Max-Bot-Api-Secret: offline-webhook-secret' \
  --data-binary '{"update_type":"message_callback","timestamp":2,"message":null,"callback":{"callback_id":"smoke.cb","payload":"python:ping","user":{"user_id":123}}}')" = 200 ]
py_compose exec -T max-bot python -c "import urllib.request; urllib.request.build_opener(urllib.request.ProxyHandler({})).open(urllib.request.Request('https://max-api:3001/mode', data=b'{\"mode\":\"hang\"}', headers={'Content-Type':'application/json'})).read()"
[ "$(deliver python.timeout)" = 500 ]
py_compose exec -T max-bot python -c "import urllib.request; urllib.request.build_opener(urllib.request.ProxyHandler({})).open(urllib.request.Request('https://max-api:3001/mode', data=b'{\"mode\":\"normal\"}', headers={'Content-Type':'application/json'})).read()"
[ "$(deliver python.recovered)" = 200 ]
py_compose exec -T max-bot python app.py diagnose
py_compose exec -T max-bot python -c "import json, urllib.request; d=json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open('https://max-api:3001/stats')); assert all(p in ('/me','/subscriptions','/messages') for m,p in d['calls']); assert all(m=='GET' for m,p in d['calls'] if p=='/subscriptions')"
[ "$nginx_id" = "$(py_compose ps -q nginx)" ]
node_compose up -d --no-deps --no-build --force-recreate --wait --wait-timeout 90 max-bot
for attempt in $(seq 1 12); do
  if [ "$(deliver node.after)" = 200 ]; then break; fi
  sleep 1
done
[ "$(deliver node.after)" = 200 ]
[ "$nginx_id" = "$(node_compose ps -q nginx)" ]
echo 'Проверено: Node → Python → Node; один Nginx, TLS в обе стороны, SDK, кнопка, таймаут/восстановление, отсутствие polling и изменения подписки.'
