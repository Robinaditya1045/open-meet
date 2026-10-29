# syntax=docker/dockerfile:1

FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.24-alpine AS server
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/meet ./cmd/meet
# Distroless has no shell to mkdir with, and a volume mounted on a directory the
# image doesn't have comes up root-owned and unwritable for the nonroot user.
RUN mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=server /out/meet /app/meet
COPY --from=web /src/web/dist /app/web
COPY --from=server --chown=65532:65532 /out/data /app/data
ENV MEET_WEB_DIR=/app/web \
    MEET_DATA_DIR=/app/data \
    MEET_HTTP_ADDR=:8088
EXPOSE 8088/tcp 7881/tcp 7882/udp
VOLUME ["/app/data"]
ENTRYPOINT ["/app/meet"]
