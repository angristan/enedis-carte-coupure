# syntax=docker/dockerfile:1

FROM golang:1.22-alpine AS build

WORKDIR /src

RUN apk add --no-cache ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/enedis-carte-coupure ./cmd/server

FROM node:22-alpine AS frontend

WORKDIR /src

COPY package.json package-lock.json vite.config.js ./
COPY frontend ./frontend

RUN npm ci
RUN npm run build

FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata \
  && adduser -D -H -u 10001 app

WORKDIR /app

ENV GOMEMLIMIT=384MiB \
  GOGC=75

COPY --from=build /out/enedis-carte-coupure /app/enedis-carte-coupure
COPY --from=frontend /src/web /app/web

RUN mkdir -p /app/cache \
  && chown -R app:app /app

USER app

EXPOSE 5177

CMD ["/app/enedis-carte-coupure", "-web-dir", "/app/web"]
