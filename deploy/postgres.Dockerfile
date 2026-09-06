FROM postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685

# The upstream image's gosu binary can lag Go security rebuilds. su-exec is a
# small Alpine C helper with the same one-way root-to-postgres drop used here.
RUN apk add --no-cache su-exec=0.3-r0 libuuid=2.42.3-r1 libssl3=3.5.8-r0 libcrypto3=3.5.8-r0 \
    && sed -i 's/exec gosu postgres/exec su-exec postgres/' /usr/local/bin/docker-entrypoint.sh \
    && ! grep -q 'exec gosu postgres' /usr/local/bin/docker-entrypoint.sh \
    && rm -f /usr/local/bin/gosu
