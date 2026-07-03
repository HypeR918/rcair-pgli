FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Tomsk

# Установка корневых сертификатов НУЦ Минцифры России.
# Необходима для корректной работы с platform-api2.max.ru.
# Если скачивание по HTTPS не проходит, скачайте сертификаты вручную
# и замените RUN с curl на COPY certs/*.crt /usr/local/share/ca-certificates/
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL -o /usr/local/share/ca-certificates/russian_trusted_root_ca_pem.crt \
       https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt \
    && curl -fsSL -o /usr/local/share/ca-certificates/russian_trusted_sub_ca_pem.crt \
       https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt \
    && update-ca-certificates \
    && mkdir -p /app/certs \
    && for f in /usr/local/share/ca-certificates/russian_trusted_*.crt; do sed 's/\r$//' "$f"; echo; done > /app/certs/russian-ca-bundle.crt \
    && rm -rf /var/lib/apt/lists/*

# Явно указываем Node.js использовать установленные сертификаты
ENV NODE_EXTRA_CA_CERTS=/app/certs/russian-ca-bundle.crt

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p /app/tmp/uploads \
    && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "index.js"]
