from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow_clickhouse_plugin.hooks.clickhouse import ClickHouseHook
from datetime import datetime, timedelta

KAFKA_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS crm_customers_kafka
(
  payload String
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list = 'kafka:9092',
  kafka_topic_list = 'crm.public.customers',
  kafka_group_name = 'ch_crm_customers_v2',
  kafka_format = 'JSONAsString',
  kafka_num_consumers = 1
"""

STAGING_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS crm_customers_staging
(
  id UInt64,
  name String,
  email String,
  age UInt32,
  gender String,
  country String,
  address String,
  phone String,
  op String,
  ts_ms DateTime64(3),
  is_deleted UInt8
)
ENGINE = MergeTree
ORDER BY id
"""

MATERIALIZED_VIEW_SQL = """
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_crm_customers
TO crm_customers_staging AS
WITH
  if(JSONHas(payload, 'payload'), JSONExtractRaw(payload, 'payload'), payload) AS envelope,
  JSONExtractRaw(envelope, 'after') AS after,
  JSONExtractString(envelope, 'op') AS op
SELECT
  toUInt64(JSONExtractInt(after, 'id')) AS id,
  JSONExtractString(after, 'name') AS name,
  JSONExtractString(after, 'email') AS email,
  toUInt32(ifNull(JSONExtractInt(after, 'age'), 0)) AS age,
  JSONExtractString(after, 'gender') AS gender,
  JSONExtractString(after, 'country') AS country,
  JSONExtractString(after, 'address') AS address,
  JSONExtractString(after, 'phone') AS phone,
  op,
  toDateTime64(JSONExtractInt(envelope, 'ts_ms') / 1000, 3) AS ts_ms,
  if(op = 'd', 1, 0) AS is_deleted
FROM crm_customers_kafka
WHERE after IS NOT NULL
"""

CUSTOMERS_MART_SQL = """
CREATE TABLE IF NOT EXISTS crm_customers_mart
(
  id UInt64,
  name String,
  email String,
  age UInt32,
  gender String,
  country String,
  address String,
  phone String,
  updated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id
"""

CUSTOMERS_MART_VIEW_SQL = """
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_crm_customers_mart
TO crm_customers_mart AS
SELECT
  id,
  name,
  email,
  age,
  gender,
  country,
  address,
  phone,
  ts_ms AS updated_at
FROM crm_customers_staging
WHERE is_deleted = 0
"""

def create_kafka_table():
    ch_hook = ClickHouseHook(clickhouse_conn_id='olap_db')
    ch_hook.execute(KAFKA_TABLE_SQL)


def create_staging_table():
    ch_hook = ClickHouseHook(clickhouse_conn_id='olap_db')
    ch_hook.execute(STAGING_TABLE_SQL)


def create_materialized_view():
    ch_hook = ClickHouseHook(clickhouse_conn_id='olap_db')
    ch_hook.execute(MATERIALIZED_VIEW_SQL)

def create_customers_mart():
    ch_hook = ClickHouseHook(clickhouse_conn_id='olap_db')
    ch_hook.execute(CUSTOMERS_MART_SQL)


def create_customers_mart_view():
    ch_hook = ClickHouseHook(clickhouse_conn_id='olap_db')
    ch_hook.execute(CUSTOMERS_MART_VIEW_SQL)


with DAG(
    dag_id='init_cdc_clickhouse',
    start_date=datetime(2026, 4, 12),
    schedule=None,
    catchup=False,
    max_active_runs=1,
    default_args={
        'retries': 0,
        'execution_timeout': timedelta(minutes=5)
    }
) as dag:
    create_kafka_table_task = PythonOperator(
        task_id='create_kafka_table',
        python_callable=create_kafka_table
    )

    create_staging_table_task = PythonOperator(
        task_id='create_staging_table',
        python_callable=create_staging_table
    )

    create_materialized_view_task = PythonOperator(
        task_id='create_materialized_view',
        python_callable=create_materialized_view
    )

    create_customers_mart_task = PythonOperator(
        task_id='create_customers_mart',
        python_callable=create_customers_mart
    )

    create_customers_mart_view_task = PythonOperator(
        task_id='create_customers_mart_view',
        python_callable=create_customers_mart_view
    )

    create_kafka_table_task >> create_staging_table_task >> create_materialized_view_task
    create_materialized_view_task >> create_customers_mart_task >> create_customers_mart_view_task
