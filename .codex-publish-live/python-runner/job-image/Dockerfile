FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gcc \
    libxml2-dev \
    libxslt1-dev \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
  beautifulsoup4==4.12.3 \
  google-generativeai==0.8.3 \
  httpx==0.28.1 \
  lxml==5.3.0 \
  numpy==2.2.1 \
  openai==1.59.7 \
  pandas==2.2.3 \
  pydantic==2.10.4 \
  python-dateutil==2.9.0.post0 \
  requests==2.32.3

WORKDIR /workspace
