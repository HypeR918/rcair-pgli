# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt ./
# Необязательный CA нужен только для сборки через прокси облачной среды.
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then \
      PIP_CERT=/run/secrets/proxy_ca python -m pip install --no-cache-dir -r requirements.txt; \
    else \
      python -m pip install --no-cache-dir -r requirements.txt; \
    fi
COPY --chown=1000:1000 app.py ./
RUN useradd --uid 1000 --create-home bot
USER bot
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD python -c "import urllib.request; urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:3000/health', timeout=3)"
CMD ["python", "app.py"]
