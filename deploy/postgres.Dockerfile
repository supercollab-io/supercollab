FROM postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15

# The upstream image's gosu binary can lag Go security rebuilds. su-exec is a
# small Alpine C helper with the same one-way root-to-postgres drop used here.
RUN apk add --no-cache su-exec=0.3-r0 \
    && sed -i 's/exec gosu postgres/exec su-exec postgres/' /usr/local/bin/docker-entrypoint.sh \
    && ! grep -q 'exec gosu postgres' /usr/local/bin/docker-entrypoint.sh \
    && rm -f /usr/local/bin/gosu
