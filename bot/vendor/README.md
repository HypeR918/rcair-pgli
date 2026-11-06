# AMQP runtime для сборки без сети

`amqp-runtime.tgz` содержит npm-пакеты amqplib 0.10.9 и его четыре зависимости
из package-lock.json. Исходные LICENSE и package.json сохранены в архиве.
Версии, исходные npm URL/integrity и SHA256 архива — в amqp-runtime.json.

Архив получен из npm registry, не содержит секретов, локальных настроек,
кэша npm или данных проекта. Проверка: `node scripts/verify-amqp-vendor.mjs`.

Обычный Dockerfile по-прежнему использует npm ci. deploy/Dockerfile.queue
использует уже имеющийся Node22-образ, его зависимости/CA и этот архив;
RUN не обращается к сети. Это позволяет не повторять сетевую проблему pip.
При обновлении зависимости нужно обновить package-lock, архив и manifest вместе.
