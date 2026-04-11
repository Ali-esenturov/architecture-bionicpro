CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100),
    email VARCHAR(100),
    age NUMERIC,
    gender VARCHAR(10),
    country VARCHAR(100),
    address VARCHAR(255),
    phone VARCHAR(255)
);

COPY customers(id, name, email, age, gender, country, address, phone)
FROM '/initial-data/crm.csv'
DELIMITER ','
CSV HEADER;