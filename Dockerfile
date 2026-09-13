# --- Build stage ---
# Use minimal official Go alpine image to compile a static binary
FROM golang:1.26-alpine AS build

# Create app directory
WORKDIR /app

# Copy module files first so deps are cached separately from source changes
COPY go.mod ./
RUN go mod download

# Copy the rest of the source
COPY cmd/ ./cmd/

# Build a static binary named js-unpack
RUN CGO_ENABLED=0 GOOS=linux go build -o /js-unpack ./cmd/

# --- Final stage ---
# Minimal runtime image, just the binary
FROM alpine:3.24

WORKDIR /app

# Copy the compiled binary from the build stage
COPY --from=build /js-unpack /usr/local/bin/js-unpack

# Make binary executable
RUN chmod +x /usr/local/bin/js-unpack

# Default entrypoint to the binary
ENTRYPOINT ["js-unpack"]