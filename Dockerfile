FROM node:22-alpine AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY web ./web
RUN npm run build

FROM golang:1.26-alpine AS go
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /coordinator ./cmd/coordinator

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=go /coordinator ./coordinator
COPY --from=web /src/web ./web
ENV LISTEN_ADDR=0.0.0.0:8787
EXPOSE 8787
ENTRYPOINT ["/app/coordinator"]
