#!/usr/bin/env bash
# Настоящие процессы ingress/worker, MariaDB/RabbitMQ/Nginx и локальный TLS MAX.
set -euo pipefail
bot_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d /tmp/rcair-rabbit-smoke.XXXXXX)"
project="rcair-rabbit-smoke-$$"
export RCAIR_QUEUE_TEST_DIR="$test_dir" RCAIR_QUEUE_BOT_DIR="$bot_dir"
export MAX_BOT_QUEUE_BASE="$test_dir/base.yml" MAX_BOT_QUEUE_IMAGE=rcair-queue-app:test
export MAX_BOT_RABBIT_CONTAINER_NAME="$project-rabbit" MAX_BOT_WORKER_CONTAINER_NAME="$project-worker"
export MAX_BOT_NGINX_CONTAINER_NAME="$project-nginx"
export MAX_BOT_NGINX_CONF="$bot_dir/deploy/nginx.docker.conf" MAX_BOT_TLS_DIR="$test_dir"
export MAX_BOT_BIND_IP=127.0.0.1 MAX_BOT_HTTP_PORT=0 MAX_BOT_HTTPS_PORT=0
export RABBITMQ_DEFAULT_USER=fixture RABBITMQ_DEFAULT_PASS=offline-test
export RABBITMQ_URL=amqp://fixture:offline-test@rabbitmq:5672
export EVENT_PAYLOAD_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
compose() { docker compose --env-file /dev/null -p "$project" -f "$test_dir/base.yml" \
  -f "$bot_dir/deploy/docker-compose.nginx.yml" -f "$bot_dir/deploy/docker-compose.rabbitmq.yml" "$@"; }
cleanup() {
  result=$?; trap - EXIT
  if [ "$result" -ne 0 ]; then compose logs --tail 30 >&2 || true; fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$test_dir"
  exit "$result"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=botsupport.gov70.ru \
  -addext subjectAltName=DNS:botsupport.gov70.ru,DNS:platform-api2.max.ru \
  -keyout "$test_dir/privkey.pem" -out "$test_dir/fullchain.pem" 2>/dev/null
chmod 644 "$test_dir/fullchain.pem"
cat > "$test_dir/init.sql" <<'SQL'
CREATE DATABASE bot;
CREATE DATABASE glpi;
USE glpi;
CREATE TABLE glpi_users (id INT PRIMARY KEY, name VARCHAR(255), realname VARCHAR(255), firstname VARCHAR(255), entities_id INT, is_active INT, is_deleted INT);
CREATE TABLE glpi_useremails (id INT PRIMARY KEY, users_id INT, email VARCHAR(255), is_default INT);
CREATE TABLE glpi_tickets (id INT PRIMARY KEY, is_deleted INT);
CREATE TABLE glpi_tickets_users (tickets_id INT, users_id INT, type INT);
SQL
chmod 644 "$test_dir/init.sql"
cat > "$test_dir/base.yml" <<'YAML'
services:
  max-bot-db:
    image: mariadb:11.4
    environment:
      MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: "1"
      MARIADB_ROOT_HOST: "%"
    volumes:
      - ${RCAIR_QUEUE_TEST_DIR}/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 1s
      timeout: 4s
      retries: 45
  max-api:
    image: node:22-bookworm-slim
    command: ["node", "/fixtures/queue-max-api.mjs"]
    environment:
      NODE_EXTRA_CA_CERTS: /fixtures/fullchain.pem
    volumes:
      - ${RCAIR_QUEUE_BOT_DIR}/test/helpers/queue-max-api.mjs:/fixtures/queue-max-api.mjs:ro
      - ${RCAIR_QUEUE_TEST_DIR}/fullchain.pem:/fixtures/fullchain.pem:ro
      - ${RCAIR_QUEUE_TEST_DIR}/privkey.pem:/fixtures/privkey.pem:ro
    networks:
      default:
        aliases: [platform-api2.max.ru]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('https://platform-api2.max.ru/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 1s
      timeout: 4s
      retries: 30
  max-bot:
    image: rcair-queue-app:test
    restart: unless-stopped
    environment:
      DOTENV_CONFIG_PATH: /dev/null
      BOT_TOKEN: offline-token
      BOT_TRANSPORT: webhook
      WEBHOOK_URL: https://botsupport.gov70.ru/max/callback/
      WEBHOOK_SECRET: offline-secret
      BOT_DB_HOST: max-bot-db
      BOT_DB_USER: root
      BOT_DB_NAME: bot
      GLPI_DB_HOST: max-bot-db
      GLPI_DB_USER: root
      GLPI_DB_NAME: glpi
      GLPI_API_URL: https://offline.invalid/apirest.php
      GLPI_API_USER_TOKEN: offline
      GLPI_IMPORT_URL: http://offline.invalid:3100
      GLPI_IMPORT_SECRET: offline-secret
      TEMP_UPLOAD_DIR: /tmp/rcair-uploads
      NODE_EXTRA_CA_CERTS: /fixtures/fullchain.pem
      NO_PROXY: localhost,127.0.0.1,max-api,platform-api2.max.ru,max-bot-db,rabbitmq,nginx,max-bot
      no_proxy: localhost,127.0.0.1,max-api,platform-api2.max.ru,max-bot-db,rabbitmq,nginx,max-bot
    volumes:
      - ${RCAIR_QUEUE_TEST_DIR}/fullchain.pem:/fixtures/fullchain.pem:ro
    depends_on:
      max-bot-db:
        condition: service_healthy
      max-api:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 1s
      timeout: 4s
      retries: 45
YAML
compose up -d --no-build --wait --wait-timeout 150
nginx_id="$(compose ps -q nginx)"
https_port="$(compose port nginx 443)"; https_port="${https_port##*:}"
deliver() {
  curl --noproxy botsupport.gov70.ru --silent --show-error --cacert "$test_dir/fullchain.pem" \
    --resolve "botsupport.gov70.ru:$https_port:127.0.0.1" --connect-timeout 2 --max-time 5 \
    -o "$test_dir/response" -w '%{http_code}' -H 'Content-Type: application/json' -H 'X-Max-Bot-Api-Secret: offline-secret' \
    --data-binary "{\"update_type\":\"message_created\",\"timestamp\":1,\"message\":{\"sender\":{\"user_id\":${2:-123},\"is_bot\":false},\"recipient\":{\"chat_id\":456,\"chat_type\":\"dialog\"},\"body\":{\"mid\":\"$1\",\"text\":\"/start\",\"attachments\":[]}}}" \
    "https://botsupport.gov70.ru:$https_port/max/callback/"
}
stats() { compose exec -T max-bot node scripts/events.mjs status 2>/dev/null || compose exec -T max-bot-worker node scripts/events.mjs status; }
wait_state() {
  for attempt in $(seq 1 100); do
    if stats | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["states"][sys.argv[1]]>=int(sys.argv[2]) else 1)' "$1" "$2"; then return; fi
    sleep 0.2
  done
  return 1
}
calls() { compose exec -T max-bot node --input-type=module -e "console.log((await(await fetch('https://platform-api2.max.ru/stats')).json()).messages)"; }
mode() { compose exec -T max-bot node --input-type=module -e "await fetch('https://platform-api2.max.ru/mode',{method:'POST',body:JSON.stringify({mode:'$1'})})"; }
[ "$(deliver first)" = 200 ]; [ "$(deliver first)" = 200 ]
wait_state done 1
[ "$(calls)" = 1 ]
# При закрытом HTTP ingress relay в worker должен продолжить FIFO drain.
[ "$(deliver drain.one)" = 200 ]; [ "$(deliver drain.two)" = 200 ]
compose stop max-bot
wait_state done 3
compose up -d --no-deps --no-build --wait --wait-timeout 90 max-bot
for attempt in $(seq 1 12); do
  if compose exec -T nginx wget -Y off -q -O /dev/null http://127.0.0.1:8081/health; then break; fi
  sleep 1
done
compose stop rabbitmq
[ "$(deliver outage)" = 200 ]
wait_state pending 1
[ "$(calls)" = 3 ]
compose start rabbitmq
compose up -d --no-deps --no-build --wait --wait-timeout 120 rabbitmq max-bot-worker
wait_state done 4
[ "$(calls)" = 4 ]
mode hold
[ "$(deliver interrupted)" = 200 ]
for attempt in $(seq 1 30); do [ "$(calls)" = 5 ] && break; sleep 0.2; done
[ "$(calls)" = 5 ]
compose kill -s SIGKILL max-bot-worker
mode normal
compose exec -T max-bot-db mariadb -uroot bot -e "UPDATE bot_max_events SET lease_until = DATE_SUB(NOW(6), INTERVAL 1 SECOND) WHERE state = 'processing'"
compose up -d --no-deps --no-build --wait --wait-timeout 120 max-bot-worker
wait_state uncertain 1
[ "$(calls)" = 5 ]
[ "$(deliver other-user 456)" = 200 ]
wait_state done 5
compose exec -T max-bot node --input-type=module -e "const d=await(await fetch('https://platform-api2.max.ru/stats')).json(); if(d.updates!==0||d.subscriptions!==0) process.exit(1)"
[ "$nginx_id" = "$(compose ps -q nginx)" ]
stats
echo 'Проверено: два Node-процесса, TLS, быстрый ACK, дубликаты, падение RabbitMQ, восстановление, kill worker → UNCERTAIN без повторного handler.'
