from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.providers.postgres.hooks.postgres import PostgresHook
from airflow_clickhouse_plugin.hooks.clickhouse import ClickHouseHook
from datetime import datetime, timedelta

def transfer_data():
    pg_hook = PostgresHook(postgres_conn_id='crm_db')
    ch_hook = ClickHouseHook(clickhouse_conn_id='olap_db')

    records = pg_hook.get_records("""
        SELECT id, name, email, age, gender, country, address, phone
        FROM customers
    """)

    processed_records = [
        (
            int(r[0]),           # id
            r[1],                # name
            r[2],                # email
            int(r[3]) if r[3] is not None else None,  # age
            r[4],                # gender
            r[5],                # country
            r[6],                # address
            r[7],                # phone
        )
        for r in records
    ]

    if processed_records:
        ch_hook.execute(
            """
            INSERT INTO customers
            (id, name, email, age, gender, country, address, phone)
            VALUES
            """,
            processed_records
        )

with DAG(
    dag_id='sync_postgres_to_clickhouse_every_minute',
    start_date=datetime(2023, 1, 1),
    schedule='* * * * *',  # Updated parameter
    catchup=False,
    max_active_runs=1,
    default_args={
        'retries': 0,
        'execution_timeout': timedelta(seconds=55)
    }
) as dag:
    transfer_task = PythonOperator(
        task_id='transfer_customers',
        python_callable=transfer_data
    )


