#!/usr/bin/env bash
# Поочерёдный запуск Python/Node в существующем сервисе max-bot.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo 'Запустите через sudo bash deploy/use-python-webhook.sh' >&2
  exit 1
fi
action="${1:-switch}"
case "$action" in switch|rollback|status) ;; *) echo 'Действия: switch, rollback, status' >&2; exit 2 ;; esac
bot_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_dir="${MAX_BOT_DEPLOY_DIR:-/opt/max-bot}"
state_file="$deploy_dir/.python-webhook-state"
cd -- "$deploy_dir"
umask 077
exec 9>"$deploy_dir/.python-webhook.lock"
flock -n 9 || { echo 'Другой процесс уже переключает бота.' >&2; exit 1; }

args=(-p max-bot)
if [ -f "$deploy_dir/.env" ]; then args+=(--env-file "$deploy_dir/.env"); fi
args+=(
  --env-file "$deploy_dir/webhook.env"
  -f "$deploy_dir/docker-compose.yml"
  -f "$deploy_dir/docker-compose.webhook.yml"
  -f "$bot_dir/deploy/docker-compose.nginx.yml"
)
export MAX_BOT_PYTHON_CONTEXT="$bot_dir/python_webhook"
compose_node() { docker compose "${args[@]}" "$@"; }
compose_python() { docker compose "${args[@]}" -f "$bot_dir/deploy/docker-compose.python.yml" "$@"; }

rollback() {
  if [ ! -f "$state_file" ]; then echo 'Нет сохранённого состояния для отката.' >&2; return 1; fi
  local previous_image rollback_file result=0
  read -r previous_image < "$state_file"
  [[ "$previous_image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Повреждён файл состояния.' >&2; return 1; }
  docker image inspect "$previous_image" >/dev/null || return 1
  rollback_file="$(mktemp "$deploy_dir/.python-rollback.XXXXXX.yml")"
  printf 'services:\n  max-bot:\n    image: %s\n' "$previous_image" > "$rollback_file"
  docker compose "${args[@]}" -f "$rollback_file" up -d --no-deps --no-build --pull never \
    --force-recreate --wait --wait-timeout 120 max-bot || result=$?
  rm -f -- "$rollback_file"
  if [ "$result" -eq 0 ]; then
    rm -f -- "$state_file"
    echo 'Возвращён прежний образ Node-бота.'
  else
    echo 'Откат не завершён; образ и файл состояния сохранены.' >&2
  fi
  return "$result"
}

if [ "$action" = rollback ]; then rollback; exit; fi
if [ "$action" = status ]; then
  docker ps --filter name=max_bot --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
  if [ -f "$state_file" ]; then echo 'Сохранён образ Node для отката.'; fi
  exit
fi
if [ -f "$state_file" ]; then
  echo 'Уже есть сохранённый Python-тест. Сначала выполните rollback.' >&2
  exit 1
fi
compose_node config --quiet
compose_python config --quiet
previous_image="$(docker inspect -f '{{.Image}}' max_bot)"
[[ "$previous_image" =~ ^sha256:[a-f0-9]{64}$ ]]
if [ "$(docker inspect -f '{{.Config.Image}}' max_bot)" = max-glpi-bot:python-webhook ]; then
  echo 'Python уже запущен, но файл отката отсутствует. Переключение остановлено.' >&2
  exit 1
fi
backup_tag="max-glpi-bot:before-python-$(date -u +%Y%m%d-%H%M%S)"
docker image tag "$previous_image" "$backup_tag"
echo "Образ для отката: $backup_tag"
docker build -t max-glpi-bot:python-webhook "$bot_dir/python_webhook"
printf '%s\n' "$previous_image" > "$state_file"

restore_on_exit=1
cleanup() {
  result=$?
  trap - EXIT
  if [ "$restore_on_exit" = 1 ]; then
    echo 'Переключение не завершено; возвращаем Node.' >&2
    rollback || echo 'Нужен ручной rollback этой же командой.' >&2
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
compose_python up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 120 max-bot
docker exec max_bot python app.py diagnose
restore_on_exit=0
echo 'Python-тест запущен: /start, /menu, текст и кнопка. GLPI-функции временно недоступны.'
echo "Откат: sudo bash $bot_dir/deploy/use-python-webhook.sh rollback"
