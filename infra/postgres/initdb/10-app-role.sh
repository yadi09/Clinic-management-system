#!/bin/sh
# Runs once on first Postgres init (docker-entrypoint-initdb.d). Creates the
# least-privilege LOGIN role the application connects as. RLS is only enforced
# for non-superuser, NOBYPASSRLS roles — never point api/worker at the
# superuser. Migrations (run as the superuser) GRANT this role its privileges.
set -e

if [ -z "${APP_DB_PASSWORD}" ]; then
  echo "WARNING: APP_DB_PASSWORD not set; skipping clinic_app role creation" >&2
  exit 0
fi

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<-SQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
      CREATE ROLE clinic_app LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    ELSE
      ALTER ROLE clinic_app LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
    END IF;
  END
  \$\$;
  GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO clinic_app;
SQL

echo "clinic_app role ready"
