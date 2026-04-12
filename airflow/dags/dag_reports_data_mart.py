from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow_clickhouse_plugin.hooks.clickhouse import ClickHouseHook
from datetime import datetime, timedelta

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS reports_customer_emg_mart (
  user_id UInt32,
  name String,
  email String,
  age UInt32,
  gender String,
  country String,
  address String,
  phone String,
  prosthesis_type String,
  muscle_group String,
  signal_frequency UInt32,
  signal_duration UInt32,
  signal_amplitude Decimal(5,2),
  signal_time DateTime
)
ENGINE = MergeTree()
ORDER BY (user_id, signal_time)
"""

TRUNCATE_SQL = "TRUNCATE TABLE reports_customer_emg_mart"

INSERT_SQL = """
INSERT INTO reports_customer_emg_mart
SELECT
  c.id AS user_id,
  c.name,
  c.email,
  c.age,
  c.gender,
  c.country,
  c.address,
  c.phone,
  e.prosthesis_type,
  e.muscle_group,
  e.signal_frequency,
  e.signal_duration,
  e.signal_amplitude,
  e.signal_time
FROM customers c
INNER JOIN emg_sensor_data e
    ON c.id = e.user_id
"""

def refresh_reports_mart():
  ch_hook = ClickHouseHook(clickhouse_conn_id='olap_db')
  ch_hook.execute(CREATE_TABLE_SQL)
  ch_hook.execute(TRUNCATE_SQL)
  ch_hook.execute(INSERT_SQL)

with DAG(
  dag_id='refresh_reports_customer_emg_mart',
  start_date=datetime(2026, 4, 11),
  schedule='*/15 * * * *',
  catchup=False,
  max_active_runs=1,
  default_args={
      'retries': 1,
      'execution_timeout': timedelta(minutes=10)
  }
) as dag:
  refresh_task = PythonOperator(
      task_id='refresh_reports_mart',
      python_callable=refresh_reports_mart
  )