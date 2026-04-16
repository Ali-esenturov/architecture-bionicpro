CREATE TABLE IF NOT EXISTS emg_sensor_data (
    user_id UInt32,
    prosthesis_type String,
    muscle_group String,
    signal_frequency UInt32,
    signal_duration UInt32,
    signal_amplitude Decimal(5,2),
    signal_time DateTime
) ENGINE = MergeTree()
ORDER BY (user_id, prosthesis_type, signal_time);

CREATE TABLE IF NOT EXISTS customers (
    id UInt32,
    name String,
    email String,
    age UInt32,
    gender String,
    country String,
    address String,
    phone String
) ENGINE = MergeTree()
ORDER BY (id, name, email);

INSERT INTO emg_sensor_data
SELECT *
FROM file('olap.csv', 'CSV');