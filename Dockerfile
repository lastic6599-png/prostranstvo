FROM node:22-alpine
WORKDIR /app

# Сертификаты Минцифры — нужны только для GigaChat (Сбер).
# Если скачать не удалось, сборка не падает; YandexGPT работает и без них.
RUN mkdir -p /certs && cd /certs \
 && (wget -q https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt -O root.crt \
  && wget -q https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt -O sub.crt \
  && cat root.crt sub.crt > russian_trusted_ca.pem \
  || (echo "WARN: сертификаты Минцифры не скачаны — GigaChat работать не будет" && touch russian_trusted_ca.pem))
ENV NODE_EXTRA_CA_CERTS=/certs/russian_trusted_ca.pem

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public

# Папка для SQLite, если DATABASE_URL не задан (лучше подключить Postgres)
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server/server.js"]
