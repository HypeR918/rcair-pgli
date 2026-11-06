# Node webhook: MariaDB inbox и RabbitMQ

Основной бот снова только Node.js 22. Эксперимент Python удалён обратным
коммитом; история сохранена. URL MAX и TLS/Nginx остаются прежними.

Текстовые рассылки зарегистрированным пользователям: BROADCAST_DEPLOY.md.
У них отдельная RabbitMQ-очередь и Bearer secret; helper настраивает его при update.

```text
MAX → Nginx:443 → max_bot (ingress) → COMMIT bot_max_events → HTTP200
                                ↓ relay в worker / publisher confirm
                          RabbitMQ: только ID события
                                ↓ manual ACK
                    max_bot_worker → SDK/GLPI/SQL/SMTP
```

Приём не ждёт GLPI, SMTP, RabbitMQ или исходящий MAX API. Если MariaDB не
подтвердила сохранение, возвращается 503. При недоступном Rabbit событие остаётся
в SQL; relay в worker позже публикует ID. Он продолжает работать и при закрытом
HTTP ingress, в том числе во время drain. Источник истины — InnoDB, не память процесса.
Существующая подписка не перерегистрируется. Предполагается проверенный прежний
URL `https://botsupport.gov70.ru/max/callback/` и тот же WEBHOOK_SECRET.

## Запуск на текущем сервере

Нужны запущенный Node-контейнер max_bot и существующие файлы
/opt/max-bot/docker-compose.yml, docker-compose.webhook.yml, webhook.env.
По последнему присланному логу Python не собрался и не заменил Node.

```bash
(
set -euo pipefail
cd /opt/max-bot/rcair-pgli
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Есть незакоммиченные изменения; обновление остановлено.'
  exit 1
fi
git switch feat/glpi-max-webhook
git pull --ff-only origin feat/glpi-max-webhook
sudo bash bot/deploy/use-rabbitmq.sh switch
)
```

Helper:

1. Создаёт /opt/max-bot/rabbitmq.env (0600) с отдельными паролем RabbitMQ и
   EVENT_PAYLOAD_SECRET. При повторных запусках файл сохраняется. Значения не
   выводятся. Исходные .env/webhook.env не редактируются.
2. Сохраняет текущий Node-образ, собирает новый поверх него **с --network none**.
   Старые зависимости, CA и Node22 сохраняются. Пять AMQP npm-пакетов берутся
   из проверяемого vendor-архива; npm ci, apt и скачивание CA не выполняются.
3. Скачивает и запускает только RabbitMQ, готовит таблицы. Для Docker pull
   нужен доступ хостового Docker к registry; доступ build-контейнера к npm/PyPI
   не нужен. Брокер хранит данные в именованном томе, его порты не публикуются.
4. Останавливает прежний единственный Node, затем запускает worker и ingress.
   Нельзя одновременно держать старый Node и новый worker: оба запускали бы
   фоновые задачи и имели разные кэши сессий. Во время переключения возможен 502.
5. БД и Nginx не пересоздаются. Исходный образ записывается в
   /opt/max-bot/.rabbitmq-node-state для безопасного отката.

Worker получает полную прежнюю конфигурацию бота из защищённого снимка
/opt/max-bot/.rabbitmq-base.yml. Он создаётся Compose с --no-interpolate и
--no-env-resolution, содержимое не печатается. У worker нет опубликованного
порта 3000; его health доступен только в Docker-сети.

Контейнеры: max_bot (ingress), max_bot_worker, max_bot_rabbitmq,
прежние max_bot_nginx и max_bot_db. Интерфейс бота и GLPI-функции сохранены.

Если прежний helper остановился на `unknown flag: --no-build` после запуска
RabbitMQ, обновите ветку и повторите `switch`. Ошибка происходила до `init`
и остановки прежнего бота. Повторный запуск сохраняет созданные rabbitmq.env,
ключ шифрования и том брокера. Удалять их или выполнять `down -v` не нужно.
Исправленный `compose run` использует `--pull never`; `--no-build` допустим
у `compose up`, но не у `compose run`.

## Что создаётся в MariaDB

- bot_max_events: уникальный ключ события, тип, зашифрованный payload,
  статус, attempts, lease, время публикации/повтора и безопасный код ошибки.
- bot_max_event_streams: HMAC-ключ пользователя для InnoDB-блокировки при
  приёме из двух producer (MAX и решения СДС). Она предотвращает обгон
  незакоммиченного раннего события более поздним.

Таблицы создаются идемпотентно в существующей базе бота. Существующие таблицы
и данные этой миграцией очереди не удаляются. Входящий текст, включая код email,
зашифрован AES-256-GCM. После DONE payload очищается, identity остаётся для
дедупликации поздних повторов. RabbitMQ и его dead queue содержат только ID.
Сохраняйте rabbitmq.env вместе с резервной копией БД: без прежнего
EVENT_PAYLOAD_SECRET незавершённые payload нельзя расшифровать. Не меняйте ключ
при наличии незавершённых событий. Метаданные DONE автоматически не удаляются.

## Обработка и ограничения повторов

Worker — единственный владелец кэша сессий и поллеров. Дополнительно защищён
named lock MariaDB и эксклюзивным Rabbit consumer. По умолчанию prefetch=4:
разные пользователи обрабатываются параллельно, один — по порядку SQL ID.
Решения СДС тоже проходят через события и общий user gate.
Не масштабируйте worker/ingress произвольно: поддержана одна пара процессов.

Relay читает готовые события каждые 200 мс (прежде — 1000 мс). Это сокращает
ожидание публикации при доступных БД/RabbitMQ; полный ответ также зависит от
доставки MAX и времени обработчика. Восстановление истёкших lease проверяется
не чаще раза в секунду, чтобы не учащать UPDATE. Одновременно работает один
проход relay, поэтому медленные SQL/publisher confirms не создают параллельные
проходы. В `/diagnostics` worker значение видно как `relay.interval_ms`.
Для настройки добавьте EVENT_RELAY_INTERVAL_MS в rabbitmq.env и выполните
`update`; допустимо 100–5000 мс. Меньший интервал увеличивает частоту SELECT.

В логе EVENT_WORKER: `queue_wait_ms` — время от создания события в SQL до
захвата worker; `duration_ms` — время после захвата до фиксации результата;
`total_ms` — их сумма. Время очереди считается SQL-сервером, без преобразования
DATETIME часовым поясом Node. При повторах оно включает предыдущие попытки.
Эти метрики не включают доставку MAX до нашего сервера и отображение ответа
клиентом мессенджера. Payload и секреты в замеры не попадают.

| Состояние | Значение |
| --- | --- |
| pending | Сохранено; ожидает публикации или времени безопасного повтора |
| processing | Захвачено worker, lease обновляется |
| done | Middleware завершился, результат зафиксирован, payload удалён |
| failed | Ошибка требует проверки или исчерпаны попытки безопасной команды |
| uncertain | Прерван начатый handler или неизвестен результат внешней записи |

HTTP200 означает приём в SQL. DONE не обязательно означает новое сообщение:
возможны ранний return/действие без ответа. Результаты отправки видны в логах
worker attempted/confirmed/failed; confirmed подтверждает API, не прочтение.
ID события связывает ingress persisted и worker: это внутренний номер, не MAX ID.

После сбоя до STARTED событие возвращается в pending по истечении lease.
После аварии начатого handler оно становится uncertain и не повторяется само.
Обычный сбой /start, /menu, bot_started допускает до 5 попыток с backoff, пока
нет неоднозначной записи GLPI. Ошибка MAX на /start больше не вызывает каскад
трёх отправок сообщений об ошибке. Остальные бизнес-сценарии автоматически
не переигрываются: это может повторно создать заявку или неверно сдвинуть FSM.
FAILED/UNCERTAIN блокирует последующие события того же пользователя; другие
пользователи продолжают обработку. Гарантии exactly-once для GLPI/SMTP/MAX нет.

## Проверка на сервере

Отправьте /start, нажмите кнопку, продолжите диалог. Повторите после паузы и
с другого аккаунта. Затем:

```bash
sudo docker exec max_bot node scripts/events.mjs status
sudo docker logs --since 5m --tail 100 max_bot_worker
sudo docker logs --since 5m --tail 60 max_bot
sudo docker logs --since 5m --tail 40 max_bot_nginx
```

CLI показывает состояния/возраст очереди и последние события без payload,
адресатов, email, токенов или Rabbit URL. `diagnose-webhook.mjs` по-прежнему
проверяет подписку и локальный ingress, но ответы worker оцениваются отдельно.
На недоступность broker указывает relay, на зависший handler — worker diagnostics.
Для общей проверки:

```bash
sudo bash /opt/max-bot/rcair-pgli/bot/deploy/use-rabbitmq.sh status
```

## Разрешение проблемного события

Сначала проверьте по времени и GLPI, была ли создана/изменена заявка. Таймаут
не означает, что удалённая операция не выполнилась. После проверки оператор
выбирает: skip — считать разрешённым и продолжить диалог; retry — выполнить
заново с риском дубля внешней операции. Аргумент --confirm обязателен.

```bash
# Подставьте реальный внутренний ID из status. Не выполняйте обе команды подряд.
sudo docker exec max_bot node scripts/events.mjs resolve --id 123 --action skip --confirm
# Только когда проверено, что повтор безопасен:
sudo docker exec max_bot node scripts/events.mjs resolve --id 123 --action retry --confirm
```

## Обновление после первого запуска

После git pull выполните:

```bash
sudo bash /opt/max-bot/rcair-pgli/bot/deploy/use-rabbitmq.sh update
```

Helper сохраняет queued-образ, пересобирает без сети и заменяет **оба** сервиса.
Worker получает до 180 секунд на завершение начатых задач. Pending события
сохраняются и продолжаются новой версией. При ошибке возвращается прежний образ
обеих queued-ролей. Исходный синхронный образ для rollback остаётся сохранённым.
Не запускайте старое обновление только max_bot из WEBHOOK_DEPLOY.md.

## Откат к прежнему синхронному Node

```bash
sudo bash /opt/max-bot/rcair-pgli/bot/deploy/use-rabbitmq.sh rollback
```

Сначала останавливается ingress, worker получает до 120 секунд на завершение
всех событий. При pending/processing/failed/uncertain или ошибке БД откат
запрещается: queued ingress возвращается, worker/события/том сохраняются.
После полного drain останавливается worker, затем SQL locking read повторно
проверяет отсутствие событий от всех producer. Только после этого восстанавливается
точный ID старого образа с исходной Compose-конфигурацией. Rabbit и таблицы не удаляются.
Не делайте compose down -v и не удаляйте файл состояния для обхода проверки.

## Проверки разработки

`DOTENV_CONFIG_PATH=/dev/null npm test` — unit/регрессии. Новые интеграционные
тесты требуют отдельные RCAIR_TEST_DB_PORT и RCAIR_TEST_RABBIT_PORT (localhost,
root без пароля только для временной БД; Rabbit user rcair-test/offline-test).
`test/rabbitmq.smoke.sh` поднимает собственный проект с реальными двумя Node,
MariaDB11.4, RabbitMQ4.2, Nginx и локальной HTTPS платформой MAX. Проверяет
дубликаты, outage брокера и аварийное прерывание worker. Он не вызывает рабочие
MAX/GLPI и не читает .env. Боевая доставка проверяется отдельно оператором.
