# Architecture Bionic Pro

## Что делает проект
Система обеспечивает полный путь: аутентификация и авторизация пользователя, получение данных из OLTP через CDC, формирование отчётов в OLAP, сохранение отчётов в S3 и выдача через CDN.

## Технологии
- `Keycloak` + `OpenLDAP` + `MFA (TOTP)` для аутентификации и авторизации
- `Yandex ID` как внешний Identity Provider
- `PostgreSQL` (CRM, OLTP)
- `Debezium` + `Kafka` для CDC
- `ClickHouse` (`KafkaEngine` + `Materialized View`) для OLAP
- `Airflow` для orchestration
- `Node.js` (`auth-service`, `reports-api`)
- `Minio` (S3 API) для хранения отчётов
- `Nginx` как CDN reverse proxy с кэшированием

## Сквозной поток
1. Пользователь логинится через `Keycloak` (LDAP или Yandex ID).
2. `auth-service` ведёт сессию по `PKCE` и cookie.
3. Изменения из CRM попадают в Kafka через `Debezium`.
4. ClickHouse читает Kafka в `crm_customers_staging` и собирает `crm_customers_mart`.
5. Airflow формирует финальную витрину `reports_customer_emg_mart`.
6. `reports-api` строит отчёт по периоду, кладёт JSON в Minio и возвращает CDN-ссылку.
7. Nginx отдаёт файл с кэшем.

## DAG pipelines
- `init_cdc_clickhouse`
Назначение: инициализация CDC-слоя в ClickHouse.
Создаёт `crm_customers_kafka`, `crm_customers_staging`, `mv_crm_customers`, `crm_customers_mart`, `mv_crm_customers_mart`.

- `backfill_crm_customers_mart`
Назначение: заполнение `crm_customers_mart` из уже полученных CDC-данных в `crm_customers_staging`.
Перед backfill делает `TRUNCATE` mart, затем загружает актуальные записи (`argMax` по `ts_ms`).

- `refresh_reports_customer_emg_mart`
Назначение: сборка финальной отчётной витрины.
Пересобирает таблицу `reports_customer_emg_mart` (join `crm_customers_mart FINAL` + `emg_sensor_data`).

- `sync_postgres_to_clickhouse_every_minute`
Назначение: legacy DAG (старый подход без CDC).
Использовался для прямого копирования `customers` из Postgres в ClickHouse. В текущем CDC-флоу не является основным.

## Важно
**Для корректной работы интеграции с Yandex ID перед запуском обязательно обновить значение `TO_BE_UPDATED` в `clientSecret` у `IdentityProvider yandex` в `keycloak/realm-export.json` на актуальный секрет (из чата ревью задания).**

## Быстрый старт
```bash
docker compose up -d --build
```

## Базовый запуск пайплайнов
Для стабильного запуска рекомендуется выполнять пайплайны через Airflow UI:
1. Войти в `http://localhost:8081` под `admin` / `admin`
2. Запускать DAG в очереди: `init_cdc_clickhouse` → `backfill_crm_customers_mart` → `refresh_reports_customer_emg_mart`
3. Дождаться статуса `success` у каждого DAG перед запуском следующего
4. Проверять таблицы после каждого этапа:
- после `init_cdc_clickhouse`: `crm_customers_staging`
- после `backfill_crm_customers_mart`: `crm_customers_mart`
- после `refresh_reports_customer_emg_mart`: `reports_customer_emg_mart`

## Проверка отчёта через Frontend UI:
После успешного выполнения всех DAG:
- войти в `https://localhost:3000` под `alex.johnson` / `password` (тестовые данные отчётов размечены под этого пользователя)
- пройти MFA (Google Authenticator)
- запросить отчёт по периоду, где есть данные (нажать `Download Report`)
- если выбрать дату, превышающую последнюю дату в подготовленном датасете, сервис вернёт ошибку
- для подготовленных данных использовать период `01/01/2025 - 25/03/2025`
- в ответе должна быть `cdnUrl`
- ожидаемый результат: `13` записей в отчёте

- открыть окно инкогнито и повторить тот же флоу под `john.doe` / `password`
- ожидаемый результат для `john.doe`: `9` записей в отчёте

Проверка обновления данных в реальном времени (CDC):
- в первой генерации отчёта для `alex.johnson` поле `country` ожидается как `Falkland Islands (Malvinas)`
- в `crm_db` выполнить изменение:
```bash
docker exec -it $(docker compose ps -q crm_db) psql -U crm_user -d crm_db -c "UPDATE customers SET country = 'Japan' WHERE id = 1;"
```
- после успешного прохождения CDC быстрее всего вручную запустить пересборку витрины `refresh_reports_customer_emg_mart`, после чего при следующей генерации отчёта `country` должен стать `Japan`
- важно: если отчёт отдан из кэша, значение сразу не обновится; в этом случае изменить диапазон дат или дождаться инвалидации кэша

## Вход через Yandex ID
- открыть `https://localhost:3000` и нажать `Login`
- на странице Keycloak нажать `Or sign in with Yandex ID`
- подтвердить вход и доступ к данным в окне Yandex
- после редиректа в систему завершить MFA в Keycloak (если включён)
- после успешного входа открыть страницу отчётов и запросить отчёт
- для пользователя, вошедшего через Yandex ID, в текущем тестовом наборе данных записи в отчёте не ожидаются

## Полный reset
```bash
docker compose down -v
docker compose up -d --build
```
После reset обязательно снова запустить:
- `init_cdc_clickhouse`
- `backfill_crm_customers_mart`
- `refresh_reports_customer_emg_mart`

## Полезные адреса
- Keycloak: http://localhost:8080
- Airflow: http://localhost:8081
- Minio Console: http://localhost:9001
- CDN: http://localhost:8082

## Примечания
- Отчёты кэшируются в Minio и раздаются через Nginx CDN.
- Ключ отчёта версионируется по времени последней обработки, чтобы кэш оставался актуальным.
