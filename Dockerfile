FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3128
ENV U2NET_HOME=/app/models
ENV PYTHONUNBUFFERED=1
ENV PATH=/app/.venv/bin:$PATH

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv libgomp1 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY requirements.txt ./

RUN python3 -m venv /app/.venv \
  && /app/.venv/bin/pip install --no-cache-dir --upgrade pip \
  && /app/.venv/bin/pip install --no-cache-dir -r requirements.txt

COPY public ./public
COPY remove_background.py server.js ./

EXPOSE 3128

CMD ["node", "server.js"]
