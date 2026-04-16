#!/bin/sh
set -eu

KC_SERVER="http://keycloak:8080"
KC_REALM="master"
KC_USER="${KEYCLOAK_ADMIN:-admin}"
KC_PASS="${KEYCLOAK_ADMIN_PASSWORD:-admin}"

echo "[keycloak-init] waiting for keycloak..."
until /opt/keycloak/bin/kcadm.sh config credentials --server "$KC_SERVER" --realm "$KC_REALM" --user "$KC_USER" --password "$KC_PASS" >/dev/null 2>&1; do
  sleep 2
done

echo "[keycloak-init] configuring realms"
/opt/keycloak/bin/kcadm.sh update realms/master -s sslRequired=NONE >/dev/null 2>&1 || true
/opt/keycloak/bin/kcadm.sh update realms/reports-realm -s sslRequired=NONE >/dev/null 2>&1 || true

echo "[keycloak-init] assigning service account roles"
/opt/keycloak/bin/kcadm.sh add-roles -r reports-realm \
  --uusername service-account-reports-api \
  --cclientid realm-management \
  --rolename view-users >/dev/null 2>&1 || true

/opt/keycloak/bin/kcadm.sh add-roles -r reports-realm \
  --uusername service-account-reports-api \
  --cclientid realm-management \
  --rolename query-users >/dev/null 2>&1 || true

/opt/keycloak/bin/kcadm.sh add-roles -r reports-realm \
  --uusername service-account-reports-api \
  --cclientid realm-management \
  --rolename manage-users >/dev/null 2>&1 || true

echo "[keycloak-init] done"
