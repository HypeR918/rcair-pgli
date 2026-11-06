# Надёжный приём MAX через MariaDB и RabbitMQ

> Реализовать последовательно по этому плану; независимая проверка через requesting-code-review. Не запускать рабочие сервисы/читать .env.

**Goal:** Вернуться к Node, подтверждать webhook после сохранения события, обрабатывать через RabbitMQ без повторного выполнения завершённых событий.

**Architecture:** MariaDB — источник истины (inbox и состояние публикации в одной таблице); RabbitMQ хранит только ID и подтверждает публикацию. Два процесса: приём и один worker+relay с ограниченной параллельностью; весь кэш сессий/фоновые задачи принадлежат worker. Consumer эксклюзивный; разные пользователи параллельно, одному — по ID события. Relay продолжает drain при остановленном ingress.

**Tech Stack:** Node22, mysql2, amqplib0.10.9, MariaDB, RabbitMQ4, существующие SDK/контроллеры/MAX webhook.

## Ограничения

- Не читать .env/ключи и не менять рабочую подписку из тестов.
- Удалить эксперимент Python обратным коммитом; историю сохранить.
- HTTP200 только после записи события в InnoDB; ошибка БД →503.
- AES-256-GCM для payload (включая вводимые коды email); Rabbit получает только ID.
- Повторный mid/callback/bot_started не создаёт вторую запись. Данные DONE очищаются.
- Подтверждение Rabbit может потеряться: повтор уведомления безопасен через CAS состояния БД.
- Прерывание после старта handler не повторяется автоматически: UNCERTAIN. Обычный сбой безопасных /start,/menu,bot_started — до 5 попыток с backoff, если нет неоднозначного GLPI POST. Для остальных FAILED/UNCERTAIN нужна ручная проверка. Не обещать exactly-once удалённого HTTP.
- Состояния до начала handler можно вернуть в PENDING после lease; зависшие начатые — UNCERTAIN. Сохранять порядок пользователя, пока ошибка не разрешена.
- Без публикации портов Rabbit наружу и без удаления существующих томов.
- Начальный деплой останавливает старый единственный Node перед запуском worker; откат к синхронной версии допускается только после остановки ingress и опустошения inbox.
- Сборка на сервере без сети: база — сохранённый Node-образ, AMQP runtime архив с версиями/хешами/лицензиями.

## Review focus

- Потеря соединения на INSERT/confirm/ACK/markDone и повтор MAX.
- Убийство worker после внешнего POST, второй consumer и истёкший lease.
- Порядок одного пользователя при параллельности, SDS и повторах уведомлений.
- Утечки payload, кодов email, Rabbit URL/пароля в логах/CLI/образе.
- Брокер недоступен при приёме и недопустимый откат с необработанными событиями.

## Этапы

- [x] Отменить эксперимент Python без потери истории.
- [x] `queue/eventStore.js`, `queue/eventCodec.js`, `queue/config.js`: схема/криптография/идентичность, accept, publish batch, claim/start/done/fail/recover/status; тесты реальной MariaDB. Общий порядок двух producer защищён строкой bot_max_event_streams.
- [x] `queue/rabbit.js`, `queue/relay.js`, `queue/worker.js`: подтверждения, reconnect, exclusive consumer, lease и безопасное завершение; тесты брокера/перезапуска.
- [x] `index.js`, `transport/maxTransport.js`, `utils/userUpdates.js`, `polling/sdsPolling.js`: роли webhook/worker, быстрый ACK, единственный владелец сессий/поллеров, диагностика; сохранить direct-test harness.
- [x] `deploy/docker-compose.rabbitmq.yml`, `deploy/Dockerfile.queue`, `deploy/use-rabbitmq.sh`, `vendor/`: offline build, секреты/том, смена/откат без DB down.
- [x] `scripts/events.mjs`, `RABBITMQ_DEPLOY.md`, AGENTS: состояние очереди, контролируемое разрешение ошибок, команды деплоя.
- [x] Настоящие MariaDB+RabbitMQ+Node+Nginx, outage/recovery/duplicates; полная регрессия и независимый review.

## Проверки 6 ноября 2026

- Полный Node22 набор с отдельными MariaDB/RabbitMQ: 104/104, без skip.
- Offline image build с --network none поверх Node-базы без AMQP зависимостей: pass.
- Docker smoke: два процесса, TLS, INSERT→200, дубликаты, drain двух сообщений
  одного пользователя при остановленном ingress, broker outage/recovery,
  SIGKILL worker→UNCERTAIN без повторного handler, другой пользователь работает.
- Review-замечания закрыты: DB-side stream gate, стабильная SDS identity,
  отсутствие memory dedup в SQL worker, channel close recovery, stop/claim race,
  relay в worker и финальный fenced drain после остановки producers.
- Тесты локальные; живые MAX/GLPI не вызывались. Развёртывание на сервере —
  отдельный пользовательский запуск helper из RABBITMQ_DEPLOY.md.
