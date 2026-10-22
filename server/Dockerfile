# The relay plus ActivityWatch's server, in one container.
#   docker build -t tt-relay server/
#   docker run -e TT_KEY=... -v tt-data:/data -p 8080:8080 tt-relay
# ActivityWatch listens only inside the container (127.0.0.1:5600); the relay
# on :8080 is the one public port and puts the web UI behind TT_KEY.

# The dashboard (dashboard/), built here and served by the relay at /app/.
FROM node:24-slim AS dashboard
WORKDIR /dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/ ./
RUN npm run build

FROM python:3.12-slim

# ActivityWatch's official Linux build (x86_64). aw-server-rust has the web UI built in.
ARG AW_VERSION=v0.13.2
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && curl -fsSL -o /tmp/aw.zip \
      "https://github.com/ActivityWatch/activitywatch/releases/download/${AW_VERSION}/activitywatch-${AW_VERSION}-linux-x86_64.zip" \
 && unzip -q /tmp/aw.zip -d /opt \
 && ln -s "$(find /opt/activitywatch -type f -name aw-server-rust | head -n1)" /usr/local/bin/aw-server \
 && aw-server --version \
 && rm /tmp/aw.zip && apt-get purge -y unzip && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY ttserver ./ttserver
COPY --from=dashboard /dashboard/dist ./dashboard/dist

ENV TT_DATA=/data \
    PORT=8080 \
    TT_AW_URL=http://127.0.0.1:5600 \
    TT_AW_COMMAND="aw-server --host 127.0.0.1 --port 5600 --dbpath /data/aw-server.db --no-legacy-import"
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD curl -fsS http://127.0.0.1:8080/tt/health || exit 1
CMD ["python", "-m", "ttserver"]
