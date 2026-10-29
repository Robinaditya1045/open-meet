.PHONY: dev server web build test test-go test-web e2e docker clean

# Go server (:8088) and Vite (:5188) together.
dev:
	./dev.sh

server:
	cd server && go run ./cmd/meet

web:
	cd web && npm run dev

# One binary that serves the API, signaling, SFU and the built client.
build:
	cd web && npm ci && npm run build
	cd server && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o ../bin/meet ./cmd/meet
	@echo "bin/meet built; run it from server/ (or set MEET_WEB_DIR) to serve web/dist"

test: test-go test-web

test-go:
	cd server && go vet ./... && go test -race ./...

test-web:
	cd web && npx tsc --noEmit -p tsconfig.app.json && npm run lint

# Browser tests against a running server (make build && bin/meet, or make dev with BASE=http://localhost:5188).
e2e:
	cd e2e && npm install --no-audit --no-fund && npm test

docker:
	docker build -t open-meet .

clean:
	rm -rf bin web/dist e2e/shots
