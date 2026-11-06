# AGENTS.md

Файл для AI-агентов, работающих с этим репозиторием. Описывает архитектуру, команды запуска, соглашения и подводные камни проекта.

## О проекте

Чат-бот для мессенджера **MAX** (`platform-api2.max.ru`) — служба технической поддержки «ОЦАИР ТО». Бот интегрирован с **GLPI** (ITSM-система заявок): пользователи авторизуются по корпоративному email, создают заявки с вложениями, получают уведомления о комментариях/решениях, принимают или отклоняют решения и оценивают качество. Новых пользователей бот регистрирует через заявку СДС (сбор данных), которую утверждают администраторы в GLPI, после чего учётная запись импортируется из LDAP.

Документация, комментарии в коде и все пользовательские тексты — **на русском языке**.

## Технологический стек

- Node.js 22 (по Dockerfile), ES-модули (`"type": "module"` в package.json), без транспиляции и шага сборки.
- `@maxhub/max-bot-api` — SDK бота MAX (API, middleware, inline-клавиатуры). Long polling в основном боте запрещён.
- `mysql2/promise` — пулы базы бота/GLPI и отдельный ограниченный пул inbox.
- `amqplib` — RabbitMQ, publisher confirms и manual ACK; источник истины — MariaDB.
- `axios` (+ `form-data`) — GLPI REST API, скачивание вложений из MAX, вызовы importer'а.
- `nodemailer` — отправка кодов верификации email по SMTP.
- `dotenv` — конфигурация через `.env`.
- Тесты — встроенный `node:test`; внешнего тестового фреймворка, линтера и форматтера нет.

## Структура проекта

```
index.js                  — роли webhook (HTTP → inbox) и worker (сессии/хендлеры/GLPI),
                            /health на PORT (3000), graceful shutdown
queue/                    — encrypted inbox, FIFO, leases, Rabbit confirms/consumer и relay
config/env.js             — чтение .env, requireEnv() проверяет обязательные переменные
transport/                — только MAX webhook, проверка секрета, HTTP и подписки
  webhookBot.js           — экземпляр SDK с запретом запуска polling и чтения /updates
  maxClient.js            — общий JSON HTTP-клиент MAX: Axios, TLS/proxy, timeout + AbortSignal
  updateDispatcher.js     — middleware SDK и дедупликация трёх типов событий
  webhookContext.js       — callback без message: личный ответ по user_id
  webhookDiagnostics.js   — безопасные счётчики приёма/обработки и ID процесса
scripts/diagnose-webhook.mjs — подписка, Node POST, Docker Nginx TLS POST и наблюдение
WEBHOOK_DEPLOY.md          — запуск webhook на botsupport.gov70.ru, проверки и Nginx
WEBHOOK_AUDIT.md           — воспроизведённые ошибки, исправления, пределы доказательств
controllers/
  userController.js       — вход: /start, /menu, bot_started; email-верификация, блокировка
  messageController.js    — единый роутер message_created: диспетчеризация по State сессии
  sdsController.js        — диалог регистрации СДС, обработка approve/reject от polling'а
  ticketController.js     — заявки: создание, список, комментарии, решения, оценки;
                            все bot.action(...) обработчики callback-кнопок
services/
  dbService.js            — пулы botPool/glpiPool, ensureDatabaseSchema() (автомиграции),
                            вся работа с таблицами бота
  dbPool.js               — ограничение acquire/команд, удаление зависшего соединения
  glpiService.js          — клиент GLPI REST API: кэш session_token (30 мин), retry на 401,
                            создание/обновление тикетов, followup'ы, решения, документы
  sdsService.js           — импорт пользователя из LDAP через HTTP-вызов glpi-importer'а
  emailService.js         — генерация 6-значного кода, HMAC-SHA256 хэш, отправка письма
  maxFileService.js       — скачивание вложений MAX в tmp/uploads (лимит 20 МБ), очистка
state/sessionStore.js     — сессии: in-memory Map + персистентность в таблице bot_sessions
polling/
  ticketPolling.js        — опрос заявок GLPI: новые комментарии, решения, закрытие
  sdsPolling.js           — опрос СДС-заявок: разбор решения администратора по ключевым словам
ui/keyboards.js           — inline-клавиатуры (Keyboard из max-bot-api)
utils/
  operationContext.js     — AsyncLocalStorage: этап ожидания и причина конечной ошибки
  constants.js            — State (конечный автомат сессии), GlpiTicketStatus (1..6),
                            approveWords/rejectWords для разбора решений СДС
  textUtils.js            — stripHtml, parseDecisionText, truncateText, textHash и пр.
  validation.js           — isValidEmail, isNotEmptyText
glpi-importer.js          — ОТДЕЛЬНЫЙ сервис (порт 3100) на хосте GLPI: по HTTP-запросу
                            выполняет `docker exec glpi php bin/console
                            glpi:ldap:synchronize_users` с фильтром по email
cleanup-local-bot-db.js   — разовый скрипт очистки локальных данных бота (нужен флаг --yes)
Dockerfile                — прод-образ бота (node:22-bookworm-slim, USER node, /health)
ARCHITECTURE.md           — mermaid-диаграммы всех сценариев (авторизация, заявки, polling)
DB_SCHEMA.md              — ER-диаграмма (частично устарела, см. «Подводные камни»)
REPLIKI_BOTA.md           — каталог всех реплик бота по сценариям
реплики.txt, диаграммы.txt — рабочие черновики тех же материалов
tmp/uploads/              — временные вложения (создаётся на лету, в .dockerignore)
miniproject/              — отдельный мини-прототип другого бота, к основному не относится
query_db.py               — посторонняя dev-утилита, к боту отношения не имеет
```

## Архитектура и основные сценарии

Полные sequence-диаграммы — в `ARCHITECTURE.md`. Кратко:

1. **Транспорт**: только `BOT_TRANSPORT=webhook`. Ingress сохраняет encrypted payload в bot_max_events и возвращает 200 после commit; существующую подписку не меняет и исходящий MAX при старте не вызывает. Worker получает ID через RabbitMQ, исполняет middleware без memory completed-cache, фиксирует SQL результат и ACK. `/updates` запрещён. Инструкция — `RABBITMQ_DEPLOY.md`.
2. **Сессии**: конечный автомат на пользователя (max_id) принадлежит одному worker. SQL head-of-user и общий user gate задают порядок MAX/SDS; разные пользователи могут идти параллельно. Для приема ingress и SDS общий InnoDB stream lock. Сессии — Map + bot_sessions, открытый код и files не сохраняются; inbox шифруется AES-256-GCM.
3. **Авторизация**: `/start` → проверка блокировки → поиск `max_id` в базе → ввод email → (если `EMAIL_VERIFICATION_ENABLED=true`) 6-значный код по SMTP (HMAC-хэш, TTL 10 мин, 3 попытки, затем блокировка MAX ID) → импорт/поиск пользователя в GLPI через importer → привязка `max_id` к `glpi_users`. Если пользователь не найден — запускается диалог СДС.
4. **Заявки**: тема → описание → файлы → подтверждение → `POST /Ticket` в GLPI → документы через `POST /Document` + `POST /Document_Item`. Все пишущие запросы к GLPI идут с `?session_write=true` (это делает `glpiApiRequest` автоматически).
5. **Фоновые polling'и** (оба `setInterval`, с защитой от повторного входа флагом `*InProgress`):
   - `ticketPolling.js` (`GLPI_TICKET_POLL_MS`, по умолчанию 60000): все заявки на начало прохода страницами по 50; уведомления о новых публичных комментариях (дедупликация через `bot_ticket_followups`), предложенных решениях (статус 5) и закрытии (статус 6). Удалённые из GLPI заявки вычищаются из локальной базы.
   - `sdsPolling.js` (`GLPI_APPROVAL_POLL_MS`, по умолчанию 60000): решения разбираются и записываются как sds_approved/sds_rejected по стабильному request.id. Импорт/уведомление/сессия выполняются consumer, не poller.
6. **GLPI-сессия**: `initSession` по `GLPI_API_USER_TOKEN` (+ опциональный `App-Token`), токен кэшируется 30 минут, при 401 — один retry с новой сессией. Записи в `glpi_users` (`max_id`, `is_blocked`) идут напрямую в SQL в режиме best-effort; права на заявки дополнительно проверяются по текущим связям заявителей в БД GLPI.
7. **Importer**: основной бот не имеет доступа к Docker хоста GLPI, поэтому LDAP-импорт вынесен в `glpi-importer.js` — маленький HTTP-сервис (по умолчанию `127.0.0.1:3100`), единственная ручка `POST /internal/import-ldap-user {email}` с `Authorization: Bearer GLPI_IMPORT_SECRET`.

## Команды запуска

```bash
npm ci                      # установка зависимостей
node index.js               # запуск бота локально (нужен заполненный .env)
npm run start:importer      # запуск glpi-importer.js (на хосте GLPI)
node cleanup-local-bot-db.js --yes   # очистка sds_requests, blocked_max_ids, glpi_users.max_id

docker build -t max-bot .   # прод-образ
docker run --env-file .env -p 3000:3000 max-bot
```

Readiness: `GET http://localhost:3000/health` → `{"ok":true,"service":"max-bot","transport":"webhook"}`. До подтверждённого старта возвращается `503`; это не проверка внешней доставки.

`npm start` запускает `index.js`. Перед развёртыванием прочитайте `SECURITY_CHANGES.md`: там описаны настройки вложений, лимиты, повторная обработка СДС и миграция `bot_verification_limits`.

Теперь обязательны BOT_ROLE=webhook|worker, RABBITMQ_URL и постоянный
EVENT_PAYLOAD_SECRET (не меньше 32 символов). Helper создаёт отдельный
rabbitmq.env вне репозитория без изменения существующего .env. Команды обычного
одиночного запуска выше не поднимают вторую роль; текущий деплой — RABBITMQ_DEPLOY.md.
CLI `node scripts/events.mjs status` не загружает .env и не выводит payload.
Обычные сбои /start,/menu,bot_started допускают до 5 повторов; неизвестные записи
GLPI и прерванные STARTED не повторяются автоматически (FAILED/UNCERTAIN).

Внутренний `GET /diagnostics` показывает приём POST, отказы, ошибки и активные запросы;
Nginx его не публикует. `sudo docker exec -i max_bot node scripts/diagnose-webhook.mjs --watch 30`
проверяет подписку и локальные POST с nonce/ID процесса, затем предлагает отправить
`/start`. Команда использует внедрённые настройки, не открывает `.env`, не меняет
подписку и не вызывает бизнес-хендлеры для проб. `--local-only --watch 0` не обращается к MAX API.

Диагностика также связывает webhook с attempted/confirmed/failed отправки новых
сообщений и хранит историю 20 реальных событий. Подтверждение требует message.body.mid;
HTTP 200 без него считается ошибкой MAX_API_UNCONFIRMED. Это подтверждение API,
а не прочтения. Метрики не включают фоновые уведомления, editMessage и answerOnCallback.
Сравнение трёх ботов и порядок расследования — `WEBHOOK_COMPARISON.md`.

## Тестирование

`DOTENV_CONFIG_PATH=/dev/null npm test` запускает регрессионные проверки без чтения `.env` через встроенный `node:test` (Node.js 22; для изоляции зависимостей тесты используют `--experimental-vm-modules`). Рабочие секреты и сервисы для unit-тестов не нужны. Webhook-тесты поднимают локальный HTTP-сервер и используют настоящий SDK с подменой внешних сервисов. `webhook-only.test.js` проверяет реальные команды, текст, callback, `bot_started`, уведомление и отсутствие запросов `/updates`.

Интеграционный тест MariaDB пропускается без `RCAIR_TEST_DB_PORT`. Для него нужна отдельная временная MariaDB 11.4 на `127.0.0.1` с пустым паролем root; тест создаёт и удаляет уникальную БД `rcair_test_*`. Запуск: `RCAIR_TEST_DB_PORT=<порт> npm test`. Не используйте рабочую БД.

После тестов проверяйте реальные сценарии MAX/GLPI на предназначенных для этого учётных записях; unit-тесты не заменяют сквозную проверку.

## Переменные окружения

Обязательные (проверяет `requireEnv()`): `BOT_TOKEN`, `BOT_DB_HOST`, `BOT_DB_USER`, `BOT_DB_NAME`, `GLPI_DB_HOST`, `GLPI_DB_USER`, `GLPI_DB_NAME`, `GLPI_IMPORT_URL`, `GLPI_IMPORT_SECRET`, `GLPI_API_URL`, `GLPI_API_USER_TOKEN`.

Основные опциональные (значения по умолчанию в `config/env.js`): `PORT` (3000), `EMAIL_VERIFICATION_ENABLED` (false), `SMTP_*`, `GLPI_API_APP_TOKEN`, `GLPI_ENTITY_ID`, `GLPI_DEFAULT_TICKET_TYPE` / `..._REQUEST_TYPE_ID` / `..._REQUEST_CATEGORY_ID` / `..._ASSIGN_GROUP_ID`, `GLPI_APPROVAL_POLL_MS` и `GLPI_TICKET_POLL_MS` (оба 60000), `EMAIL_CODE_*` (TTL 10 мин, 3 попытки, cooldown 60 сек), `GLPI_IMPORT_*` (таймаут 130 сек, 10 проверок с шагом 1.5 сек), `TEMP_UPLOAD_DIR`, `MAX_ATTACHMENT_BYTES` (20 МБ). Для importer'а: `IMPORTER_HOST`/`IMPORTER_PORT`, `GLPI_DOCKER_CONTAINER` (glpi), `GLPI_CONTAINER_USER`, `GLPI_CONSOLE_PATH`, `GLPI_LDAP_FILTER_ATTRIBUTE` (mail).

`BOT_DB_*` и `GLPI_DB_*` при отсутствии наследуются от общих `DB_*`.

Для webhook: `BOT_TRANSPORT=webhook` (другие режимы запрещены), `WEBHOOK_URL=https://botsupport.gov70.ru/max/callback/`, `WEBHOOK_SECRET` (отдельный секрет MAX, 5–256 символов `[A-Za-z0-9_-]`). Секреты не логировать. HTTPS завершается на Nginx; Node слушает HTTP на `PORT`. Чужие подписки не удаляются автоматически; запуска MAX polling нет даже при пустом списке подписок.

## База данных

Таблицы бота создаются и мигрируют автоматически при старте (`ensureDatabaseSchema` в `services/dbService.js`): `bot_users`, `blocked_max_ids`, `sds_requests`, `bot_user_tickets`, `bot_ticket_followups`, `bot_ticket_ratings`, `bot_sessions`. Дополнительно в базу GLPI best-effort добавляются колонки `glpi_users.max_id` и `glpi_users.is_blocked`. Миграции идемпотентны (`CREATE TABLE IF NOT EXISTS`, `ADD/DROP COLUMN` с игнорированием дублей); неожиданные ошибки обязательных миграций останавливают запуск. Все запросы — только prepared statements через `pool.execute`.

## Соглашения по коду

- ES-модули с именованными экспортами; импорты сгруппированы: node builtins → библиотеки → `config` → `utils` → `services` → `state` → локальные.
- Отступ 2 пробела, одинарные кавычки, точки с запятой, `async/await` (без `.then`).
- Все тексты пользователю — на русском и по возможности из каталога `REPLIKI_BOTA.md`; логи — смесь русского и английского (сохраняйте стиль соседнего кода).
- Callback-пayload'ы кнопок: префиксы `menu:*` и `ticket:*` (`ticket:open:{id}`, `ticket:rate:{id}:{0-5}` и т.п.); новые действия регистрируйте в `registerTicketActions` через `bot.action`, текстовые состояния — через новый `State.*` и ветку в `messageController`.
- ID пользователей/тикетов нормализуются в `Number` на границах; функции сервисов бросают `Error` с русским текстом для пользовательских ошибок.
- При ошибке обработчики отвечают пользователю нейтральным сообщением и логируют детали в `console.error`; ошибки фоновых проверок GLPI не должны ронять процесс (ловятся внутри циклов). Недоставленный ответ `/start` передаётся HTTP-транспорту как ошибка, если не удалось отправить даже нейтральное сообщение.

## Безопасность

- Секреты — только в `.env` (исключён из Docker-образа через `.dockerignore`). Не коммитьте токены и пароли.
- Код верификации email хранится и сохраняется в БД только как HMAC-SHA256 (`EMAIL_CODE_SECRET`, fallback — `BOT_TOKEN`); сам код не логируется. Проверка — `crypto.timingSafeEqual`.
- Блокировка MAX ID после `EMAIL_CODE_MAX_ATTEMPTS` неверных попыток; разблокировка — только через подтверждение email.
- Имена скачиваемых файлов санитизируются (`safeFilename`), размер ограничен `MAX_ATTACHMENT_BYTES`, временные файлы удаляются после загрузки в GLPI.
- `glpi-importer.js` отказывается запускаться без `GLPI_IMPORT_SECRET`; по умолчанию сервис слушает только `127.0.0.1`. Не публикуйте importer в открытый Интернет.
- Docker-образ устанавливает корневые сертификаты НУЦ Минцифры РФ и задаёт `NODE_EXTRA_CA_CERTS` — без них TLS к `platform-api2.max.ru` не работает. Не отключайте проверку TLS в основном боте.
- В `miniproject/bot.js` захардкожен токен и стоит `NODE_TLS_REJECT_UNAUTHORIZED=0` — это изолированный прототип; не переносите эти практики в основной код (токен стоит считать скомпрометированным).

## Деплой

- Единственный прод-артефакт — Docker-образ из корневого `Dockerfile` (`node:22-bookworm-slim`, `npm ci --omit=dev`, `USER node`, `HEALTHCHECK` по `/health`, `TZ=Asia/Tomsk`, `CMD ["node", "index.js"]`).
- `deploy/Dockerfile.queue` обновляет существующий Node-образ без сети: сохраняет
  CA/прежние зависимости и добавляет проверяемый vendor AMQP runtime. Helper
  `deploy/use-rabbitmq.sh` запускает max_bot + max_bot_worker + Rabbit без DB down.
  Откат к старому образу разрешён только после полного drain и остановки producers.
- Корневого `docker-compose.yml` нет (compose-файл в `miniproject/` относится к прототипу). По `ARCHITECTURE.md` база бота — отдельный MariaDB-контейнер, доступный с хоста на `127.0.0.1:3307`; GLPI и SMTP — внешние сервисы.
- `deploy/docker-compose.nginx.yml` добавляется к существующему Compose на сервере: Nginx и бот находятся в общей сети, upstream — `max-bot:3000` с обновлением Docker DNS. `deploy/use-docker-nginx.sh` переключает хостовый Nginx на Docker и поддерживает `rollback`, не перезапуская бота/БД. Подробности — `WEBHOOK_DEPLOY.md`; `bash test/docker-nginx.smoke.sh` проверяет настоящие контейнеры без рабочих секретов.
- `glpi-importer.js` развёртывается отдельно на хосте GLPI (нужен доступ к `docker exec`).

## Подводные камни (расхождения кода и документации)

- Точка входа основного бота — `index.js`; `npm start` использует её.
- `DB_SCHEMA.md` частично устарела: перечисляет колонки (`bot_users.glpi_user_name`, `bot_user_tickets.title` и др.), которые `ensureDatabaseSchema()` наоборот удаляет. Источник истины по схеме — код миграций в `services/dbService.js`.
- В диаграммах `ARCHITECTURE.md` указан интервал опроса заявок 5 секунд — фактический дефолт `GLPI_TICKET_POLL_MS` = 60000 мс.
- `реплики.txt` — ранний черновик `REPLIKI_BOTA.md`; при изменении текстов бота обновляйте `REPLIKI_BOTA.md`.
- `query_db.py` и каталог `miniproject/` к основному боту отношения не имеют — не учитывайте их при рефакторинге основного кода.
- `services/glpiService.js` сохранён с CRLF-окончаниями строк — не переформатируйте файл целиком при точечных правках.
