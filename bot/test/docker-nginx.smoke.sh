#!/usr/bin/env bash
# Настоящие контейнеры Node.js + Nginx, тестовый TLS, без .env и внешнего MAX/GLPI.
set -euo pipefail
bot_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d /tmp/rcair-nginx.XXXXXX)"
project="rcair-nginx-smoke-$$"
export MAX_BOT_NGINX_CONF="$bot_dir/deploy/nginx.docker.conf"
export MAX_BOT_TLS_DIR="$test_dir/tls"
export MAX_BOT_NGINX_CONTAINER_NAME="$project-nginx"
export MAX_BOT_BIND_IP=127.0.0.1 MAX_BOT_HTTP_PORT=0 MAX_BOT_HTTPS_PORT=0
export RCAIR_SMOKE_BOT_DIR="$bot_dir"
compose() {
  docker compose --env-file /dev/null -p "$project" \
    -f "$test_dir/base.yml" -f "$bot_dir/deploy/docker-compose.nginx.yml" "$@"
}
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    compose logs --tail 60 >&2 || true
    docker inspect -f '{{json .State.Health}}' "$MAX_BOT_NGINX_CONTAINER_NAME" >&2 || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$project-ip-holder" >/dev/null 2>&1 || true
  # Повторное удаление сети после освобождения старого адреса.
  docker network rm "${project}_default" >/dev/null 2>&1 || true
  rm -rf -- "$test_dir"
  exit "$result"
}
trap cleanup EXIT
mkdir "$test_dir/tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=botsupport.gov70.ru -addext subjectAltName=DNS:botsupport.gov70.ru \
  -keyout "$test_dir/tls/privkey.pem" -out "$test_dir/tls/fullchain.pem" 2>/dev/null
cat > "$test_dir/base.yml" <<'YAML'
services:
  max-bot:
    image: node:22-bookworm-slim
    working_dir: /app
    command: ["node", "test/helpers/docker-webhook.mjs"]
    environment:
      DOTENV_CONFIG_PATH: /dev/null
      BOT_TOKEN: offline-token
      WEBHOOK_SECRET: offline-webhook-secret
      WEBHOOK_URL: https://botsupport.gov70.ru/max/callback/
      NODE_EXTRA_CA_CERTS: /test-ca.pem
      NO_PROXY: 127.0.0.1,localhost,nginx,max-bot
    volumes:
      - type: bind
        source: ${RCAIR_SMOKE_BOT_DIR}
        target: /app
        read_only: true
      - type: bind
        source: ${MAX_BOT_TLS_DIR}/fullchain.pem
        target: /test-ca.pem
        read_only: true
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 2s
      timeout: 3s
      retries: 15
YAML
compose config --quiet
compose up -d --wait --wait-timeout 90 max-bot
bot_before="$(compose ps -q max-bot)"
compose run --rm --no-deps nginx nginx -t
compose up -d --no-deps --wait --wait-timeout 90 nginx
[ "$bot_before" = "$(compose ps -q max-bot)" ]
https_port="$(compose port nginx 443)"
https_port="${https_port##*:}"
http_port="$(compose port nginx 80)"
http_port="${http_port##*:}"
request() {
  curl --noproxy botsupport.gov70.ru --silent --show-error \
    --cacert "$test_dir/tls/fullchain.pem" \
    --resolve "botsupport.gov70.ru:$https_port:127.0.0.1" \
    --connect-timeout 3 --max-time 5 -o "$test_dir/response" -w '%{http_code}' \
    "$@" "https://botsupport.gov70.ru:$https_port/max/callback/"
}
payload() {
  printf '{"update_type":"message_created","timestamp":1,"message":{"sender":{"user_id":123,"first_name":"Тест","is_bot":false},"recipient":{"chat_id":456,"chat_type":"dialog"},"timestamp":1,"body":{"mid":"%s","seq":1,"text":"/%s","attachments":[]}}}' "$1" "${2:-start}"
}
deliver() {
  request -H 'Content-Type: application/json' -H 'X-Max-Bot-Api-Secret: offline-webhook-secret' \
    --data-binary "$(payload "$1" "${2:-start}")"
}
[ "$(request)" = 403 ]
[ "$(request --head)" = 403 ]
[ "$(request -H 'Content-Type: application/json' --data-binary "$(payload unauthorized)")" = 403 ]
[ "$(deliver first)" = 200 ]
[ "$(deliver first)" = 200 ]
[ "$(compose logs max-bot | rg -c DOCKER_SMOKE_REPLY)" = 1 ]
[ "$(deliver failure fail)" = 500 ]
[ "$(deliver timeout stall)" = 500 ]
[ "$(deliver recovered)" = 200 ]
[ "$(compose logs max-bot | rg -c DOCKER_SMOKE_REPLY)" = 2 ]
compose exec -T max-bot node scripts/diagnose-webhook.mjs --local-only --watch 0
[ "$(compose logs max-bot | rg -c DOCKER_SMOKE_REPLY)" = 2 ]
[ "$(curl --noproxy botsupport.gov70.ru --silent --show-error \
  --resolve "botsupport.gov70.ru:$http_port:127.0.0.1" -o /dev/null -w '%{http_code}' \
  "http://botsupport.gov70.ru:$http_port/max/callback/")" = 301 ]
echo 'Проверены: TLS/имя сертификата, настоящий SDK HTTP, /start, дедупликация, таймаут/восстановление, диагностика, HTTP redirect.'

# Принудительно меняем IP бота: старый адрес временно занимает тестовый контейнер.
old_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$bot_before")"
nginx_before="$(compose ps -q nginx)"
compose rm --stop --force max-bot
docker run -d --name "$project-ip-holder" --network "${project}_default" --ip "$old_ip" \
  node:22-bookworm-slim node -e 'setInterval(() => {}, 10000)' >/dev/null
compose up -d --no-deps --wait --wait-timeout 90 max-bot
new_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(compose ps -q max-bot)")"
[ "$old_ip" != "$new_ip" ]
recovered=0
for attempt in {1..20}; do
  if [ "$(deliver after-recreate)" = 200 ]; then recovered=1; break; fi
  sleep 1
done
[ "$recovered" = 1 ]
[ "$nginx_before" = "$(compose ps -q nginx)" ]
[ "$(compose logs max-bot | rg -c DOCKER_SMOKE_REPLY)" = 1 ]
echo 'Проверено: после смены IP контейнера бота Nginx восстановил маршрут без своего перезапуска.'
