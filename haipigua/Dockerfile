# Build from the haipigua directory:
#   docker build -t haipigua .
#   docker run --rm -p 8877:8877 --env-file .env haipigua
#
# The container binds 0.0.0.0. For anything beyond a private machine, put it
# behind a reverse proxy with authentication, TLS, and request limits.
FROM node:24-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8877
ENV ALLOW_PUBLIC=1
EXPOSE 8877
CMD ["node", "server/app.cjs"]
