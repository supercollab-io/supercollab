FROM postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777

# The upstream image's gosu binary can lag Go security rebuilds. su-exec is a
# small Alpine C helper with the same one-way root-to-postgres drop used here.
RUN apk add --no-cache su-exec=0.3-r0 \
    && sed -i 's/exec gosu postgres/exec su-exec postgres/' /usr/local/bin/docker-entrypoint.sh \
    && ! grep -q 'exec gosu postgres' /usr/local/bin/docker-entrypoint.sh \
    && rm -f /usr/local/bin/gosu
