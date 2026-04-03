FROM osixia/openldap:1.5.0

# Bootstrap LDIFs are copied into the image to avoid bind-mount removal issues.
COPY config.ldif /container/service/slapd/assets/config/bootstrap/ldif/50-config.ldif
