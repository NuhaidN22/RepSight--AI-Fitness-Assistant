# RepSight: the website and the API in one image. Build from the project root:  docker build -f deploy/Dockerfile -t repsight .
# Used by Render (render.yaml) and by the always-on server kit (deploy/docker-compose.yml).

# ---- stage 1: build the website ----
FROM node:22-slim AS web
WORKDIR /web
COPY frontend-ts/package.json frontend-ts/package-lock.json ./
RUN npm ci
COPY frontend-ts/ ./
RUN npm run build

# ---- stage 2: the API, which also serves the built website ----
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY backend ./backend
COPY frontend-ts/formcheck ./frontend-ts/formcheck
COPY --from=web /web/dist ./frontend-ts/dist

# Run as an ordinary user. /data holds the SQLite file when no DATABASE_URL is set (the server kit mounts a volume there).
RUN useradd --create-home --uid 10001 app && mkdir /data && chown app /data
USER app
ENV REPSIGHT_DB=/data/app.db REPSIGHT_UPLOADS=/data/uploads

WORKDIR /app/backend
EXPOSE 8080
# PORT is set by Render (10000 by default); the server kit uses 8080. --proxy-headers: trust X-Forwarded-Proto from the proxy in front.
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips '*'"]
