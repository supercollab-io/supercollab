FROM python:3.14-alpine@sha256:26730869004e2b9c4b9ad09cab8625e81d256d1ce97e72df5520e806b1709f92

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SUPERCOLLAB_SKILLS_DIR=/app/skills \
    SUPERCOLLAB_WEB_DIR=/app/web

RUN addgroup --gid 10001 --system supercollab \
    && adduser --uid 10001 --system --disabled-password --no-create-home \
      --shell /sbin/nologin --ingroup supercollab supercollab

WORKDIR /app
COPY server/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir --requirement /app/requirements.lock

COPY server/supercollab_chat.py /app/supercollab_chat.py
COPY server/sql /app/sql
COPY skills /app/skills
COPY web /app/web

USER 10001:10001
EXPOSE 8731
CMD ["uvicorn", "supercollab_chat:app", "--host", "0.0.0.0", "--port", "8731", "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1,172.16.0.0/12"]
