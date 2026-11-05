#!/usr/bin/env bash
# Перенос существующего Nginx в Compose без перезапуска бота и БД.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'Запустите через sudo bash deploy/use-docker-nginx.sh' >&2
  exit 1
fi

action="${1:-switch}"
case "$action" in
  switch|rollback|status) ;;
  *) echo 'Действия: switch (по умолчанию), rollback, status' >&2; exit 2 ;;
esac

bot_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_dir="${MAX_BOT_DEPLOY_DIR:-/opt/max-bot}"
export MAX_BOT_NGINX_CONF="$bot_dir/deploy/nginx.docker.conf"
export MAX_BOT_TLS_DIR="${MAX_BOT_TLS_DIR:-/etc/nginx/tls/botsupport.gov70.ru}"
cd -- "$deploy_dir"

compose_args=(-p max-bot)
# Только передаём существующие файлы Docker Compose; не выводим их содержимое.
if [ -f "$deploy_dir/.env" ]; then
  compose_args+=(--env-file "$deploy_dir/.env")
fi
compose_args+=(
  --env-file "$deploy_dir/webhook.env"
  -f "$deploy_dir/docker-compose.yml"
  -f "$deploy_dir/docker-compose.webhook.yml"
  -f "$bot_dir/deploy/docker-compose.nginx.yml"
)
compose() { docker compose "${compose_args[@]}" "$@"; }

restore_host() {
  echo 'Возвращаем Nginx на хосте; бот и БД продолжают работать.' >&2
  compose stop nginx && systemctl enable --now nginx
}

if [ "$action" = rollback ]; then
  restore_host
  exit
fi
if [ "$action" = status ]; then
  compose ps max-bot nginx
  exit
fi

for cert in fullchain.pem privkey.pem; do
  if [ ! -r "$MAX_BOT_TLS_DIR/$cert" ]; then
    echo "Не найден сертификат или ключ: $MAX_BOT_TLS_DIR/$cert" >&2
    exit 1
  fi
done
compose config --quiet
bot_id="$(compose ps -q max-bot)"
if [ -z "$bot_id" ] || [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$bot_id")" != healthy ]; then
  echo 'Текущий контейнер max-bot должен быть запущен и healthy.' >&2
  exit 1
fi
# Проверяем маршрут, который понадобится при откате к Nginx на хосте.
curl --noproxy 127.0.0.1 --fail --silent --show-error \
  --connect-timeout 3 --max-time 5 -o /dev/null http://127.0.0.1:3000/health

# До остановки рабочего Nginx скачиваем образ и проверяем TLS-конфиг.
compose pull nginx
compose run --rm --no-deps nginx nginx -t

restore_on_exit=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$restore_on_exit" = 1 ]; then
    if ! restore_host; then
      echo 'Автоматический откат не завершён. Проверьте docker ps и systemctl status nginx.' >&2
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

restore_on_exit=1
systemctl stop nginx
# --no-deps: не пересоздаём и не перезапускаем бота или MariaDB.
compose up -d --no-deps --wait --wait-timeout 90 nginx

https_port="${MAX_BOT_HTTPS_PORT:-443}"
bind_ip="${MAX_BOT_BIND_IP:-0.0.0.0}"
[ "$bind_ip" != 0.0.0.0 ] || bind_ip=127.0.0.1
code="$(curl --noproxy botsupport.gov70.ru --silent --show-error \
  --resolve "botsupport.gov70.ru:$https_port:$bind_ip" \
  --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' \
  "https://botsupport.gov70.ru:$https_port/max/callback/")"
if [ "$code" != 403 ]; then
  echo "Локальная проверка HTTPS: ожидался 403 для GET, получен $code." >&2
  exit 1
fi

# Исключаем конфликт за 80/443 после перезагрузки сервера.
systemctl disable nginx
restore_on_exit=0
echo 'Готово: HTTPS → Docker Nginx → max-bot:3000. Локальная проверка TLS и GET: 403.'
echo 'Теперь отправьте /start в MAX и проверьте: sudo docker logs --since 2m max_bot_nginx'
echo 'Внешняя доставка MAX проверяется отдельно; локальная проверка её не подтверждает.'
