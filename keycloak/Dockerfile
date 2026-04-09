FROM quay.io/keycloak/keycloak:25.0.0

# Add OAuth2 IdP plugin
COPY keycloak-idp-oauth2-0.1.jar /opt/keycloak/providers/

# Build Keycloak to install providers
RUN /opt/keycloak/bin/kc.sh build
