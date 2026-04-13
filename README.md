# Architecture Bionic Pro

## Что делает проект
Полный путь от аутентификации и авторизации до генерации аналитических отчётов, их сохранения в S3 (Minio) и раздачи через CDN (Nginx).

## Основные технологии
- **Auth & IAM**: Keycloak (OIDC), LDAP (OpenLDAP), MFA (TOTP)
- **Внешний IdP**: Яндекс ID через кастомный OAuth2 IdP‑плагин
- **OLTP**: PostgreSQL (CRM)
- **CDC**: Debezium → Kafka
- **OLAP**: ClickHouse (KafkaEngine + Materialized Views)
- **Оркестрация**: Airflow
- **Reports API**: Node.js
- **Объектное хранилище**: Minio (S3 API)
- **CDN**: Nginx reverse proxy с кэшированием

## Сквозной поток
1. **Логин** через Keycloak (LDAP‑пользователи + Яндекс ID). MFA включен.
2. **Сессия** хранится в `auth-service` (PKCE, HTTP‑only cookies).
3. **CDC** забирает изменения из CRM и пишет в Kafka.
4. **ClickHouse** читает Kafka и строит staging + mart таблицы.
5. **Airflow** собирает финальную витрину отчётов.
6. **Reports API** формирует отчёт из ClickHouse и сохраняет в S3.
7. **CDN** отдаёт отчёты с кэшем.

## Быстрый старт
```bash
docker compose up -d --build
```

## Инициализация CDC + ClickHouse
```bash
docker exec -it $(docker compose ps -q airflow-webserver) \
  airflow dags trigger init_cdc_clickhouse
```

## Формирование финальной витрины
```bash
docker exec -it $(docker compose ps -q airflow-webserver) \
  airflow dags trigger refresh_reports_customer_emg_mart
```

## Получение отчёта (UI)
- Открой фронтенд, выбери период и нажми **Download Report**.
- В ответе будет **CDN‑ссылка** на файл отчёта.

## Полный сброс
```bash
docker compose down -v
```

## Полезные адреса
- Keycloak: http://localhost:8080
- Airflow: http://localhost:8081
- Minio Console: http://localhost:9001
- CDN: http://localhost:8082

## Примечания
- Отчёты кэшируются в Minio и раздаются через Nginx CDN.
- Ключи отчётов версионируются по времени последней обработки — кэш всегда актуален.
- CDC поток полностью автоматизирован (Debezium + init DAG).
