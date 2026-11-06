#!/usr/bin/env bash
# Node ingress + один worker; переключение с сохранением исходного образа.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo 'Запустите через sudo bash deploy/use-rabbitmq.sh' >&2; exit 1; }
action="${1:-switch}"
case "$action" in switch|update|rollback|status) ;; *) echo 'Действия: switch, update, rollback, status' >&2; exit 2 ;; esac
bot_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_dir="${MAX_BOT_DEPLOY_DIR:-/opt/max-bot}"
cd -- "$deploy_dir"
umask 077
exec 9>"$deploy_dir/.rabbitmq-deploy.lock"
flock -n 9 || { echo 'Переключение уже выполняется.' >&2; exit 1; }
queue_env="$deploy_dir/rabbitmq.env"
state_file="$deploy_dir/.rabbitmq-node-state"
export MAX_BOT_QUEUE_BASE="$deploy_dir/.rabbitmq-base.yml"
export MAX_BOT_QUEUE_IMAGE=max-glpi-bot:webhook

base_args=(-p max-bot)
if [ -f "$deploy_dir/.env" ]; then base_args+=(--env-file "$deploy_dir/.env"); fi
base_args+=(--env-file "$deploy_dir/webhook.env" -f "$deploy_dir/docker-compose.yml"
  -f "$deploy_dir/docker-compose.webhook.yml" -f "$bot_dir/deploy/docker-compose.nginx.yml")
base() { docker compose "${base_args[@]}" "$@"; }
queued() { docker compose "${base_args[@]}" \
  --env-file "$queue_env" -f "$bot_dir/deploy/docker-compose.rabbitmq.yml" "$@"; }
# У run нет флага --no-build: используем уже собранный image без pull.
cli() { queued run --rm --no-deps --pull never --entrypoint node max-bot /app/scripts/events.mjs "$@"; }
ensure_broadcast_secret() {
  if ! grep -q '^BROADCAST_API_SECRET=' "$queue_env"; then
    printf '\nBROADCAST_API_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$queue_env"
  fi
  chmod 600 "$queue_env"
}

if [ "$action" = status ]; then
  [ -f "$queue_env" ] && [ -f "$MAX_BOT_QUEUE_BASE" ] || { echo 'Очередь ещё не настроена.'; exit 1; }
  queued ps max-bot max-bot-worker rabbitmq nginx
  cli status
  exit
fi

if [ "$action" = update ]; then
  [ -f "$state_file" ] && [ -f "$queue_env" ] && [ -f "$MAX_BOT_QUEUE_BASE" ] || {
    echo 'Сначала выполните switch.' >&2; exit 1;
  }
  ensure_broadcast_secret
  queued config --quiet
  previous_queue_image="$(docker inspect -f '{{.Image}}' max_bot)"
  [[ "$previous_queue_image" =~ ^sha256:[a-f0-9]{64}$ ]]
  update_backup="max-glpi-bot:before-queue-update-$(date -u +%Y%m%d-%H%M%S)"
  docker image tag "$previous_queue_image" "$update_backup"
  echo "Предыдущий образ очереди: $update_backup"
  docker build --network none --build-arg "BASE_BOT_IMAGE=$update_backup" \
    -f "$bot_dir/deploy/Dockerfile.queue" -t max-glpi-bot:webhook "$bot_dir"
  cli init
  update_done=0
  restore_queue() {
    result=$?; trap - EXIT
    if [ "$update_done" = 0 ]; then
      echo 'Обновление не завершено; возвращаем предыдущий образ обеих queued-ролей.' >&2
      docker image tag "$previous_queue_image" max-glpi-bot:webhook
      queued up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 120 max-bot-worker max-bot || true
    fi
    exit "$result"
  }
  trap restore_queue EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  queued stop max-bot max-bot-worker
  queued up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 120 max-bot-worker
  queued up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 120 max-bot
  cli status
  update_done=1
  exit
fi

rollback() {
  [ -f "$state_file" ] || { echo 'Нет сохранённого Node-образа.' >&2; return 1; }
  local previous_image rollback_file result=0 drained=0
  read -r previous_image < "$state_file"
  [[ "$previous_image" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  docker image inspect "$previous_image" >/dev/null || return 1
  # Сначала прекращаем новые INSERT; worker продолжает обрабатывать принятые.
  queued stop max-bot || return 1
  for attempt in $(seq 1 24); do
    if cli assert-drained >/dev/null; then drained=1; break; fi
    sleep 5
  done
  if [ "$drained" -ne 1 ]; then
    echo 'Откат запрещён: остались события или БД недоступна. Возвращаем queued ingress.' >&2
    queued up -d --no-deps --no-build --pull never --wait --wait-timeout 120 max-bot || true
    return 1
  fi
  queued stop max-bot-worker || return 1
  # Producer SDS мог записать событие между zero-check и остановкой.
  if ! cli assert-drained >/dev/null; then
    echo 'После остановки worker остались события; синхронный откат отменён.' >&2
    queued up -d --no-deps --no-build --pull never --wait --wait-timeout 120 max-bot-worker max-bot || true
    return 1
  fi
  rollback_file="$(mktemp "$deploy_dir/.rabbitmq-rollback.XXXXXX.yml")"
  printf 'services:\n  max-bot:\n    image: %s\n' "$previous_image" > "$rollback_file"
  docker compose "${base_args[@]}" -f "$rollback_file" up -d --no-deps --no-build --pull never \
    --force-recreate --wait --wait-timeout 120 max-bot || result=$?
  rm -f -- "$rollback_file"
  if [ "$result" -eq 0 ]; then rm -f -- "$state_file"; echo 'Возвращён исходный Node-образ. RabbitMQ и таблицы сохранены.'; fi
  return "$result"
}
if [ "$action" = rollback ]; then rollback; exit; fi

if [ -f "$state_file" ]; then
  echo 'Очередь уже настроена; используйте update.' >&2
  exit 1
fi
if [ ! -f "$queue_env" ]; then
  queue_password="$(openssl rand -hex 24)"
  event_secret="$(openssl rand -hex 32)"
  printf 'RABBITMQ_DEFAULT_USER=maxbot\nRABBITMQ_DEFAULT_PASS=%s\nRABBITMQ_URL=amqp://maxbot:%s@rabbitmq:5672\nEVENT_PAYLOAD_SECRET=%s\n' \
    "$queue_password" "$queue_password" "$event_secret" > "$queue_env"
fi
chmod 600 "$queue_env"
ensure_broadcast_secret
# Полная база для extends worker, без интерполяции и чтения env_file в output.
base config --no-interpolate --no-env-resolution --format json > "$MAX_BOT_QUEUE_BASE"
queued config --quiet
previous_image="$(docker inspect -f '{{.Image}}' max_bot)"
if [ "$(docker inspect -f '{{.Config.Image}}' max_bot)" = max-glpi-bot:python-webhook ]; then
  if [ -f "$deploy_dir/.python-webhook-state" ]; then
    read -r previous_image < "$deploy_dir/.python-webhook-state"
  else
    previous_image="$(docker image inspect -f '{{.Id}}' max-glpi-bot:webhook)"
  fi
  echo 'Для возврата с Python выбран сохранённый Node-образ.'
fi
[[ "$previous_image" =~ ^sha256:[a-f0-9]{64}$ ]]
backup="max-glpi-bot:before-rabbit-$(date -u +%Y%m%d-%H%M%S)"
docker image tag "$previous_image" "$backup"
echo "Исходный образ сохранён: $backup"
# Ни npm ci, ни скачивание CA не выполняются внутри сборки.
docker build --network none --build-arg "BASE_BOT_IMAGE=$backup" \
  -f "$bot_dir/deploy/Dockerfile.queue" -t max-glpi-bot:webhook "$bot_dir"
queued pull rabbitmq
queued up -d --no-deps --wait --wait-timeout 180 rabbitmq
cli init
printf '%s\n' "$previous_image" > "$state_file"

restore=1
cleanup() {
  result=$?
  trap - EXIT
  if [ "$restore" = 1 ]; then
    echo 'Деплой не завершён; проверяем безопасный откат.' >&2
    rollback || echo 'Автооткат не выполнен; события/тома сохранены. Используйте status и RABBITMQ_DEPLOY.md.' >&2
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Не допускаем двух наборов session-cache/GLPI pollers при миграции.
base stop max-bot
queued up -d --no-deps --no-build --pull never --wait --wait-timeout 120 max-bot-worker
queued up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 120 max-bot
cli status
restore=0
rm -f -- "$deploy_dir/.python-webhook-state"
echo 'Node ingress и worker запущены; HTTP200 означает запись события в MariaDB.'
echo 'Отправьте /start в MAX, затем выполните: sudo docker exec max_bot node scripts/events.mjs status'
