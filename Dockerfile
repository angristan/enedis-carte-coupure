# syntax=docker/dockerfile:1

FROM golang:1.22-alpine AS build

WORKDIR /src

RUN apk add --no-cache ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/enedis-carte-coupure ./cmd/server

FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata \
  && adduser -D -H -u 10001 app

WORKDIR /app

COPY --from=build /out/enedis-carte-coupure /app/enedis-carte-coupure
COPY web /app/web

RUN mkdir -p /app/cache \
  && chown -R app:app /app

USER app

EXPOSE 5177

CMD ["/app/enedis-carte-coupure", "-web-dir", "/app/web"]
