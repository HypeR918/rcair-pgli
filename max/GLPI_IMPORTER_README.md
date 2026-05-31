# GLPI LDAP import через CLI

Этот файл описывает новую схему импорта пользователей из LDAP в GLPI без эмуляции веб-интерфейса.

## Общая схема

Пользователь пишет корпоративный email в чат с MAX-ботом.

Бот:

1. Проверяет, есть ли пользователь в базе GLPI по email или логину до `@`.
2. Если пользователь найден, привязывает `max_id` к найденной учетной записи GLPI.
3. Если пользователь не найден, отправляет email во внутренний importer-сервис.
4. После ответа importer-сервиса несколько раз проверяет базу GLPI.
5. Если пользователь появился, привязывает `max_id`.
6. Если пользователь не появился, переводит пользователя в сценарий заявки на регистрацию.

Importer-сервис:

1. Работает на сервере, где доступен Docker с контейнером GLPI.
2. Принимает HTTP-запрос от бота.
3. Проверяет секретный токен.
4. Проверяет формат email.
5. Экранирует email для LDAP-фильтра.
6. Запускает штатную GLPI CLI-команду внутри контейнера:

```bash
docker exec -u www-data glpi php /var/www/html/bin/console glpi:ldap:synchronize_users -c -f "(mail=user@example.ru)" -n
```

Так GLPI сам использует свои LDAP-настройки. Боту не нужен LDAP-пароль и не нужен пароль от веб-интерфейса GLPI.

## Файлы

### `bot.js`

Основной MAX-бот.

Важные функции:

- `findGlpiUserByEmailOrName(email)` - ищет пользователя в базе GLPI по `glpi_useremails.email` или по `glpi_users.name`.
- `requestGlpiLdapImport(email)` - отправляет email во внешний importer endpoint.
- `importUserFromSdsViaGlpi(email)` - общий сценарий: проверить базу, вызвать importer, снова проверить базу.
- `proceedAfterVerification(ctx, verifiedEmail)` - продолжает вход пользователя после ввода email.

### `glpi-importer.js`

Отдельный HTTP-сервис для сервера GLPI.

Его нужно запускать там, где команда `docker exec ...` может попасть в контейнер GLPI.

Endpoint:

```http
POST /internal/import-ldap-user
Authorization: Bearer <GLPI_IMPORT_SECRET>
Content-Type: application/json

{
  "email": "mesap@rcair.tomsk.ru"
}
```

Healthcheck:

```http
GET /health
```

### `glpi-importer.env.example`

Пример переменных окружения для `glpi-importer.js`.

Скопируйте нужные значения в `.env` на сервере GLPI или задайте их через systemd/Docker/PM2.

## Что нужно настроить в `.env` бота

В `.env` бота должны быть заданы:

```env
GLPI_IMPORT_URL=http://10.230.101.47:3100/internal/import-ldap-user
GLPI_IMPORT_SECRET=change_me_to_a_long_random_secret
GLPI_IMPORT_TIMEOUT_MS=130000
GLPI_IMPORT_CHECK_ATTEMPTS=10
GLPI_IMPORT_CHECK_DELAY_MS=1500
```

Что заменить:

- `10.230.101.47` - IP сервера, где запущен `glpi-importer.js`.
- `3100` - порт importer-сервиса.
- `change_me_to_a_long_random_secret` - длинный случайный секрет. Такой же секрет должен быть у importer.

Если бот и importer работают на одном сервере, можно использовать:

```env
GLPI_IMPORT_URL=http://127.0.0.1:3100/internal/import-ldap-user
```

Если бот работает на другой машине, importer должен слушать доступный сетевой интерфейс, например `0.0.0.0`, а firewall должен разрешать доступ только с IP машины бота.

## Что нужно настроить для importer

На сервере GLPI создайте env-файл по примеру:

```env
IMPORTER_HOST=0.0.0.0
IMPORTER_PORT=3100
GLPI_IMPORT_SECRET=change_me_to_a_long_random_secret

DOCKER_BIN=docker
GLPI_DOCKER_CONTAINER=glpi
GLPI_CONTAINER_USER=www-data
GLPI_CONSOLE_PATH=/var/www/html/bin/console
GLPI_LDAP_FILTER_ATTRIBUTE=mail
GLPI_IMPORT_COMMAND_TIMEOUT_MS=120000
```

Что заменить:

- `IMPORTER_HOST`
  - `127.0.0.1`, если бот на том же сервере.
  - `0.0.0.0`, если бот подключается с другой машины.

- `IMPORTER_PORT`
  - порт, на котором importer будет принимать запросы.

- `GLPI_IMPORT_SECRET`
  - такой же секрет, как в `.env` бота.

- `GLPI_DOCKER_CONTAINER`
  - имя контейнера GLPI.
  - узнать можно командой:

```bash
docker ps
```

- `GLPI_CONTAINER_USER`
  - пользователь внутри контейнера.
  - часто это `www-data`, но может быть `apache`.
  - если команда работает только без `-u`, оставьте переменную пустой:

```env
GLPI_CONTAINER_USER=
```

- `GLPI_CONSOLE_PATH`
  - путь к `bin/console` внутри контейнера.
  - проверить можно так:

```bash
docker exec glpi ls /var/www/html/bin/console
docker exec glpi php /var/www/html/bin/console --help
```

- `GLPI_LDAP_FILTER_ATTRIBUTE`
  - LDAP-атрибут для фильтра.
  - по умолчанию `mail`, потому что бот получает email.
  - если в вашем LDAP email хранится в другом поле, замените значение.

## Как сначала проверить CLI вручную

На сервере GLPI выполните:

```bash
docker exec -u www-data glpi php /var/www/html/bin/console glpi:ldap:synchronize_users --help
```

Потом проверьте импорт конкретного пользователя:

```bash
docker exec -u www-data glpi php /var/www/html/bin/console glpi:ldap:synchronize_users -c -f "(mail=mesap@rcair.tomsk.ru)" -n
```

Если контейнер называется иначе, замените `glpi`.

Если пользователь внутри контейнера другой, замените `www-data` или уберите `-u www-data`.

Если путь к console другой, замените `/var/www/html/bin/console`.

## Как запустить importer

Вариант для ручного запуска:

```bash
cd /path/to/max
npm install
cp glpi-importer.env.example .env
nano .env
npm run start:importer
```

Для постоянной работы лучше запускать через `systemd`, `pm2` или отдельный Docker-контейнер с доступом к Docker socket.

## Как проверить importer

Healthcheck:

```bash
curl http://127.0.0.1:3100/health
```

Ожидаемый ответ:

```json
{"ok":true}
```

Тест импорта:

```bash
curl -X POST http://127.0.0.1:3100/internal/import-ldap-user \
  -H "Authorization: Bearer change_me_to_a_long_random_secret" \
  -H "Content-Type: application/json" \
  -d '{"email":"mesap@rcair.tomsk.ru"}'
```

Ожидаемый успешный ответ:

```json
{
  "ok": true,
  "email": "mesap@rcair.tomsk.ru",
  "filter": "(mail=mesap@rcair.tomsk.ru)",
  "stdout": "...",
  "stderr": "..."
}
```

## Как проверить с Windows PowerShell

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://10.230.101.47:3100/internal/import-ldap-user" `
  -Headers @{ Authorization = "Bearer change_me_to_a_long_random_secret" } `
  -ContentType "application/json" `
  -Body '{"email":"mesap@rcair.tomsk.ru"}'
```

## Безопасность

Не открывайте importer в интернет.

Рекомендуется:

- слушать `127.0.0.1`, если бот работает на том же сервере;
- если нужно слушать `0.0.0.0`, открыть порт только для IP машины с ботом;
- использовать длинный случайный `GLPI_IMPORT_SECRET`;
- не логировать секрет;
- не передавать в команду сырые пользовательские строки.

В коде `glpi-importer.js` используется `execFile`, а не shell-строка. Email валидируется и экранируется для LDAP-фильтра.

## Как бот подставляет email

Пользователь пишет email в чат.

В `bot.js` этот email попадает в:

```js
await proceedAfterVerification(ctx, text);
```

Дальше:

```js
const importResult = await importUserFromSdsViaGlpi(verifiedEmail);
```

Если пользователя нет в GLPI, бот вызывает:

```js
await requestGlpiLdapImport(email);
```

И отправляет в importer:

```json
{
  "email": "email_который_ввел_пользователь"
}
```

Importer строит LDAP-фильтр:

```text
(mail=email_который_ввел_пользователь)
```

И запускает GLPI CLI с этим фильтром.

## Частые проблемы

### `GLPI_IMPORT_URL is not configured`

В `.env` бота не задан `GLPI_IMPORT_URL`.

### `forbidden`

Секрет в запросе не совпадает с `GLPI_IMPORT_SECRET` у importer.

### `bad_email`

Бот или тестовый запрос отправил строку, которая не похожа на email.

### `docker: command not found`

Importer запущен там, где нет команды `docker`, или нужно указать полный путь в `DOCKER_BIN`.

### `No such container`

Неверно указан `GLPI_DOCKER_CONTAINER`.

### `Could not open input file: /var/www/html/bin/console`

Неверно указан `GLPI_CONSOLE_PATH`.

### Пользователь не появился после успешной команды

Проверьте:

- правильный ли LDAP-атрибут используется в `GLPI_LDAP_FILTER_ATTRIBUTE`;
- находит ли GLPI пользователя при ручном запуске команды;
- есть ли у GLPI LDAP-настройки для импорта новых пользователей;
- не импортировался ли пользователь с логином, отличным от части email до `@`.
