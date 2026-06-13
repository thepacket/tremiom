# ---- 1. Frontend build (Vite + TypeScript) ----
FROM node:22-alpine AS frontend
WORKDIR /app
# git is needed during `vite build` to read the commit count + short SHA
# into the version label (see vite.config.ts / src/version.ts).
RUN apk add --no-cache git
COPY package.json package-lock.json ./
RUN npm ci
# Copy only what the build needs (the .dockerignore strips the rest).
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
# .git is kept in the build context (see .dockerignore) so the build can
# read the current commit count + short SHA. Mark it safe so git doesn't
# refuse over the container's ownership mismatch.
COPY .git ./.git
RUN git config --global --add safe.directory /app
RUN npm run build

# ---- 2. Python wheels (obspy + scipy + numpy) ----
# Done in its own stage so changes to TS source don't bust the pip cache.
FROM python:3.11-slim-bookworm AS pydeps
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY workers/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /tmp/requirements.txt && \
    # Strip pyc caches and matplotlib's huge sample data.
    find /opt/venv -type d -name __pycache__ -exec rm -rf {} + || true && \
    find /opt/venv -type d -name 'mpl-data/sample_data' -exec rm -rf {} + || true

# ---- 3. Final runtime — Python + Node ----
FROM python:3.11-slim-bookworm
WORKDIR /app

# Install Node.js LTS (22) + ca-certificates (urllib needs the CA bundle
# for ObsPy's HTTPS calls; certifi already in the venv, but belt+braces).
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Node deps (production only — no dev deps in the runtime image).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Bring in the pre-built Python venv with obspy/numpy/scipy.
COPY --from=pydeps /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
ENV TREMIOM_PYTHON=/opt/venv/bin/python

# App: server, workers, built frontend.
COPY server.mjs ./
COPY workers ./workers
COPY --from=frontend /app/dist ./dist

EXPOSE 8080
CMD ["node", "server.mjs"]
