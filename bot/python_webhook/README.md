# Минимальный Python webhook

Временный режим того же MAX-бота на botsupport.gov70.ru: `/start`, `/menu`,
фиксированный ответ на текст, тестовая кнопка и bot_started. **Авторизация,
заявки, вложения и фоновые уведомления GLPI на время теста недоступны.**
Программа не обращается к GLPI/SQL/SMTP и не изменяет данные БД.

Python 3.12, maxapi 1.2.1 (как у ЖКХ), aiohttp. Используются прежние
`max-bot:3000`, Nginx HTTPS:443, домен, сертификат, токен, secret и подписка.
При старте выполняются только GET /me и GET /subscriptions с проверкой одного
URL и трёх типов событий. Перерегистрации, удаления подписки и /updates нет.

## Запуск на сервере

```bash
(
set -euo pipefail
cd /opt/max-bot/rcair-pgli
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Есть незакоммиченные изменения; переключение остановлено.'
  exit 1
fi
git switch feat/glpi-max-webhook
git pull --ff-only origin feat/glpi-max-webhook
sudo bash bot/deploy/use-python-webhook.sh switch
)
```

Образ Python собирается до остановки Node. Helper сохраняет прежний образ,
затем пересоздаёт только max-bot с --no-deps. Контейнер max_bot остаётся
единственным обработчиком; Node и Python одновременно не запускаются.
БД и Nginx не пересоздаются. При смене IP Nginx обновляет Docker DNS;
во время переключения несколько секунд возможен 502. При ошибке старта или
диагностики helper пытается автоматически вернуть прежний образ.

Compose использует существующие env-файлы, не выводя содержимое. Программа
Python не загружает .env: читает внедрённые BOT_TOKEN, WEBHOOK_SECRET,
WEBHOOK_URL, BOT_TRANSPORT, PORT и необязательный PYTHON_MAX_TIMEOUT_SECONDS
(по умолчанию 30). TLS проверяется через системные и встроенные в maxapi CA.

## Проверка

В MAX отправьте /start, нажмите «Проверить ответ», отправьте текст. Повторите
после паузы и с другого аккаунта. Проверяйте серию сообщений. Ожидаемый ответ:
«Бот отвечает. Сейчас включён тестовый режим».

После действий, особенно при молчании, до перезапуска:

```bash
sudo docker exec max_bot python app.py diagnose
sudo docker logs --since 5m --tail 100 max_bot
sudo docker logs --since 5m --tail 60 max_bot_nginx
```

Диагностика читает только локальный /diagnostics: implementation=python-minimal,
ID процесса, типы событий, ошибки, attempted/confirmed/failed и последние 20
реальных событий. Текст, MAX ID, mid, payload и секреты в новые логи не входят.
HTTP 200 возвращается после подтверждения MAX; при ошибке — 500.
Одна отправка ограничена таймаутом, автоматических повторов нет.
Дедупликация в памяти: 10 минут, до 10000 ключей. После рестарта возможен
повтор ответа. Этот диагностический режим не содержит durable inbox/outbox.

## Возврат к Node

```bash
sudo bash /opt/max-bot/rcair-pgli/bot/deploy/use-python-webhook.sh rollback
```

Возвращаются сохранённый ID образа и исходные command/healthcheck Compose.
Файл /opt/max-bot/.python-webhook-state удаляется после успешного возврата;
не удаляйте его во время проверки. Резервный тег образа печатается при switch.
Повторный switch при существующем файле отката запрещён. Состояние:
`sudo bash bot/deploy/use-python-webhook.sh status`.
Обычный Node-деплой из WEBHOOK_DEPLOY.md тоже заменит Python, поэтому во время
сравнения используйте этот helper. Не вызывайте compose down и не удаляйте тома.

## Локальные проверки без секретов

```bash
cd bot
python3 -m venv /tmp/rcair-python-test
/tmp/rcair-python-test/bin/pip install -r python_webhook/requirements.txt
/tmp/rcair-python-test/bin/python -m unittest discover -s python_webhook -p 'test_*.py'
docker build -t max-glpi-bot:python-webhook python_webhook
bash test/python-webhook.smoke.sh
```

В облаке с прокси для Docker build добавьте BuildKit secret
`--secret id=proxy_ca,src=<путь-к-CA>`; он не копируется в образ.
Unit-тесты используют настоящий SDK и локальный HTTP MAX API. Docker smoke
проверяет Node → Python → Node через тот же Nginx, TLS в обе стороны,
команды, кнопку, таймаут/восстановление и отсутствие polling/изменения подписки.
Helper проверяется test/python-deploy.test.js с подменёнными Docker-командами.

Успех Python выделит рабочий минимальный Python-путь. Сам по себе он не докажет
дефект языка Node: одновременно изменены SDK и нагрузка. Следующий контроль
при необходимости — минимальный Node с теми же функциями и серией сообщений.
