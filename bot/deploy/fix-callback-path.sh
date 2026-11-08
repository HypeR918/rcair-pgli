#!/usr/bin/env bash
# Исправление активного bind-конфига без замены домена, TLS и настроек сервера.
set -euo pipefail
container="${1:-max_bot_nginx}"
config="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/nginx/conf.d/default.conf"}}{{.Source}}{{end}}{{end}}' "$container")"
[[ "$config" = /* ]] && [ -f "$config" ] || { echo 'Не найден bind-файл default.conf у указанного контейнера.' >&2; exit 1; }
[ -w "$config" ] && [ -w "$(dirname -- "$config")" ] || { echo 'Нет прав на конфиг. Запустите через sudo bash fix-callback-path.sh' >&2; exit 1; }
work_dir="$(mktemp -d /tmp/max-callback-fix.XXXXXX)"
trap 'rm -rf -- "$work_dir"' EXIT
docker exec "$container" cat /etc/nginx/conf.d/default.conf > "$work_dir/mounted.conf"
if ! cmp -s "$config" "$work_dir/mounted.conf"; then
  echo 'Файл на хосте отличается от подключённого в контейнер. Исправление остановлено.' >&2
  echo "Проверьте bind-файл: $config" >&2
  exit 1
fi
backup="$(mktemp "${config}.bak-callback.XXXXXX")"
cp -p -- "$config" "$backup"
if ! python3 - "$config" <<'PY'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
slash = list(re.finditer(r'(?m)^([ \t]*)location\s+(?:(?:=|\^~)\s+)?/max/callback/\s*\{', text))
if len(slash) != 1:
    raise SystemExit('Ожидался ровно один location /max/callback/. Файл не изменён.')
bare = list(re.finditer(r'(?m)^[ \t]*location\s*=\s*/max/callback\s*\{', text))
if bare:
    internal = r'(?m)^[ \t]*location\s*=\s*/max/callback\s*\{\s*rewrite\s+\^\s+/max/callback/\s+last;\s*\}'
    redirect = r'(?m)^([ \t]*)location\s*=\s*/max/callback\s*\{\s*return\s+30[12]\s+[^;{}]+;\s*\}'
    if len(bare) == 1 and re.search(internal, text):
        print('Внутренний маршрут уже настроен.')
        raise SystemExit(0)
    matches = list(re.finditer(redirect, text))
    if len(bare) != 1 or len(matches) != 1:
        raise SystemExit('Уже есть собственный location /max/callback. Требуется проверить его вручную; файл не изменён.')
    match = matches[0]
    indent = match[1]
    block = f'{indent}location = /max/callback {{\n{indent}    rewrite ^ /max/callback/ last;\n{indent}}}'
    updated = text[:match.start()] + block + text[match.end():]
else:
    match = slash[0]
    indent = match[1]
    block = f'{indent}# Внутренний переход сохраняет POST, JSON и заголовок секрета.\n{indent}location = /max/callback {{\n{indent}    rewrite ^ /max/callback/ last;\n{indent}}}\n\n'
    updated = text[:match.start()] + block + text[match.start():]
# Запись в тот же inode: контейнер видит изменение file bind mount.
with path.open('w') as target:
    target.write(updated)
PY
then
  cat -- "$backup" > "$config"
  echo "Исправление остановлено; исходный файл сохранён. Копия: $backup" >&2
  exit 1
fi
if ! docker exec "$container" nginx -t; then
  cat -- "$backup" > "$config"
  echo "Конфиг восстановлен. Резервная копия: $backup" >&2
  exit 1
fi
if ! docker exec "$container" nginx -s reload; then
  cat -- "$backup" > "$config"
  docker exec "$container" nginx -t && docker exec "$container" nginx -s reload || true
  echo "Reload не выполнен; конфиг восстановлен. Копия: $backup" >&2
  exit 1
fi
echo "Исправлен маршрут без внешнего редиректа. Конфиг: $config"
echo "Резервная копия: $backup"
