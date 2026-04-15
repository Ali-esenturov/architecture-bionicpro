from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow_clickhouse_plugin.hooks.clickhouse import ClickHouseHook
from datetime import datetime, timedelta

TRUNCATE_CUSTOMERS_MART_SQL = "TRUNCATE TABLE crm_customers_mart"

BACKFILL_CUSTOMERS_MART_SQL = """
INSERT INTO crm_customers_mart
SELECT
  id,
  argMax(name, ts_ms) AS name,
  argMax(email, ts_ms) AS email,
  argMax(age, ts_ms) AS age,
  argMax(gender, ts_ms) AS gender,
  argMax(country, ts_ms) AS country,
  argMax(address, ts_ms) AS address,
  argMax(phone, ts_ms) AS phone,
  max(ts_ms) AS updated_at
FROM crm_customers_staging
GROUP BY id
"""


def truncate_customers_mart():
    ch_hook = ClickHouseHook(clickhouse_conn_id='olap_db')
    ch_hook.execute(TRUNCATE_CUSTOMERS_MART_SQL)


def backfill_customers_mart():
    ch_hook = ClickHouseHook(clickhouse_conn_id='olap_db')
    ch_hook.execute(BACKFILL_CUSTOMERS_MART_SQL)


with DAG(
    dag_id='backfill_crm_customers_mart',
    start_date=datetime(2026, 4, 15),
    schedule=None,
    catchup=False,
    max_active_runs=1,
    default_args={
        'retries': 0,
        'execution_timeout': timedelta(minutes=5)
    }
) as dag:
    truncate_customers_mart_task = PythonOperator(
        task_id='truncate_customers_mart',
        python_callable=truncate_customers_mart
    )

    backfill_customers_mart_task = PythonOperator(
        task_id='backfill_customers_mart',
        python_callable=backfill_customers_mart
    )

    truncate_customers_mart_task >> backfill_customers_mart_task
