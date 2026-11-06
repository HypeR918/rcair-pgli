# Текстовая рассылка зарегистрированным пользователям

POST /internal/broadcasts создаёт задание в MariaDB. Отдельные relay и consumer
RabbitMQ доставляют его адресатам в фоне. Очередь — max.webhook.events.v1.broadcast,
prefetch=1, до двух отправок в секунду. Очередь диалогов и сессии рассылка не занимает.
Для каждого сообщения требуется подтверждённый MAX message.body.mid.

## Установка

```bash
(
set -euo pipefail
cd /opt/max-bot/rcair-pgli
git switch feat/glpi-max-webhook
git pull --ff-only origin feat/glpi-max-webhook
sudo bash bot/deploy/use-rabbitmq.sh update
)
```

Helper добавляет отдельный BROADCAST_API_SECRET в /opt/max-bot/rabbitmq.env,
сохраняет существующий ключ при обновлениях и права 0600. Исходный .env не
редактируется. Секрет передаётся ingress, worker его не требует. Без секрета API
выключен (404); некорректный секрет не позволяет запустить ingress.

API доступен на HTTP-порту ingress (в нашей конфигурации 127.0.0.1:3000).
Публичный Nginx проксирует только /max/callback/ и возвращает 404 для internal.
Не добавляйте общий proxy_pass для всех путей ради рассылки. При удалённом
доступе используйте SSH-туннель и отдельный Bearer secret. BOT_TOKEN и секрет
подписки MAX для авторизации этого API не подходят.

## Получатели

На момент создания фиксируется список bot_users с max_id > 0 и glpi_user_id > 0.
Пользователи с is_blocked=1 или записью в blocked_max_ids исключаются. Просто
написавшие /start без завершённой регистрации в список не попадают. Перед
захватом отправки проверка регистрации и блокировок выполняется повторно.
Рассылка не проверяет актуальную доступность аккаунта через API GLPI; MAX может
отклонить сообщение, например если пользователь заблокировал бота.

Добавившиеся после создания задания пользователи в него не включаются.
Текст — обычный, непустой, до 4000 Unicode-символов; кнопок, HTML-форматирования,
вложений и выбора отдельных адресатов в первой версии нет.

## Создание рассылки curl

Следующая команда запускает отправку текста всем подходящим получателям:

```bash
sudo docker exec -i max_bot sh -c '
curl --fail-with-body --silent --show-error \
  --connect-timeout 5 --max-time 20 \
  -X POST "http://127.0.0.1:3000/internal/broadcasts" \
  -H "Authorization: Bearer $BROADCAST_API_SECRET" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: notice-20261106-01" \
  --data-binary @-
' <<'JSON'
{"text":"Сообщение для зарегистрированных пользователей."}
JSON
```

Ответ HTTP 202: {"id":"1","created":true,"status_url":"/internal/broadcasts/1"}.
Это подтверждение сохранения задания, не завершения отправки.

Для новой рассылки меняйте Idempotency-Key. Для повтора того же запроса
сохраняйте ключ и текст: вернётся прежний ID с created=false, даже после рестарта.
Тот же ключ с другим текстом возвращает 409. Ключ содержит 8–128 символов
A-Z/a-z/0-9, _, -, ., :. В нём не должно быть адресатов или текста сообщения.
Список получателей и текст запроса в ответ API не возвращаются.

## Статус

Подставьте ID, возвращённый POST:

```bash
sudo docker exec max_bot sh -c '
curl --fail-with-body --silent --show-error \
  --connect-timeout 5 --max-time 10 \
  -H "Authorization: Bearer $BROADCAST_API_SECRET" \
  "http://127.0.0.1:3000/internal/broadcasts/1"
'
```

Альтернатива из контейнера без HTTP:

```bash
sudo docker exec max_bot node scripts/broadcasts.mjs status 1
sudo docker logs --since 5m --tail 80 max_bot_worker
```

total — число адресатов snapshot; counts — pending, processing, done, failed,
uncertain, skipped. done означает подтверждение отправки API MAX, не прочтение.
skipped означает отмену отправки (например блокировку после создания задания).
problems содержит ID отправок и безопасные коды ошибок. Статус задания running
сохраняется пока есть pending/processing; после завершения — completed либо
completed_with_errors. /diagnostics worker также содержит секцию broadcasts.

## Сбои и повторы

- Недоступный RabbitMQ оставляет задания в SQL. После восстановления relay
  опубликует ID; повторная доставка того же ID не выполняет завершённую отправку.
- HTTP 429 повторяется с задержками 5, 10, 20, 40 секунд, максимум 5 попыток.
  Прочие определённые отказы MAX становятся failed и не мешают другим адресатам.
- Обрыв соединения, HTTP 5xx, неподтверждённый успех и авария после STARTED дают
  uncertain. Автоматического повтора нет: сообщение могло уже уйти пользователю.
  Одновременно гарантировать отсутствие потерь и дубликатов при неизвестном
  результате внешнего POST без idempotency со стороны MAX невозможно.
- Авария до STARTED допускает восстановление той же отправки после lease.
- Текст хранится зашифрованным с EVENT_PAYLOAD_SECRET и удаляется из payload
  после завершения всех отправок без failed/uncertain. Для проблемных заданий
  сохраняется для проверки/ручного решения. Метаданные и idempotency остаются.

После проверки результата можно разрешить конкретную проблемную отправку.
Это delivery ID из problems, а не ID задания:

```bash
sudo docker exec max_bot node scripts/broadcasts.mjs resolve --id 17 --action skip --confirm
# Только если проверили, что повтор допустим:
sudo docker exec max_bot node scripts/broadcasts.mjs resolve --id 18 --action retry --confirm
```

Изменить скорость можно через BROADCAST_RATE_PER_SECOND в rabbitmq.env и update;
допустимо 1–5, по умолчанию 2. Реальная скорость также зависит от задержки API MAX.
Лимит задаётся для одного последовательного broadcast consumer.

Откат к legacy Node блокируется при незавершённых/проблемных рассылках вместе
с обычными событиями. Таблицы и том RabbitMQ при откате сохраняются. Резервируйте
rabbitmq.env вместе с БД: EVENT_PAYLOAD_SECRET нужен для расшифровки.

Проверки выполняются на временной MariaDB/RabbitMQ и локальной заглушке MAX.
Реальные массовые сообщения при разработке и тестировании не отправляются.
