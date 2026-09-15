#!/usr/bin/env bash
# Build script for Morse Chat using Buildah
# This script builds a production-ready OCI image

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

IMAGE_NAME="${1:-federated-morse-chat}"
IMAGE_TAG="${2:-latest}"
REGISTRY="${3:-}"
BASE_IMAGE="docker.io/library/node:20-alpine"
SERVER_PORT=7002

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ============================================================================
# Helper Functions
# ============================================================================

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

usage() {
    cat <<EOF
Usage: $(basename "$0") [IMAGE_NAME] [IMAGE_TAG] [REGISTRY]

Build a Docker/OCI image for Morse Chat using Buildah.

Arguments:
  IMAGE_NAME   Name of the image (default: federated-morse-chat)
  IMAGE_TAG    Tag for the image (default: latest)
  REGISTRY     Registry to push (default: none, just build)

Examples:
  $(basename "$0")
  $(basename "$0") my-morse-chat v1.0.0
  $(basename "$0") my-morse-chat v1.0.0 ghcr.io/myuser
EOF
    exit 1
}

cleanup() {
    if [ -n "${container:-}" ]; then
        log_info "Cleaning up container: ${container}"
        buildah umount "${container}" 2>/dev/null || true
        buildah rm "${container}" 2>/dev/null || true
    fi
}

trap cleanup EXIT

# ============================================================================
# Validate Buildah
# ============================================================================

if ! command -v buildah &> /dev/null; then
    log_error "Buildah is not installed. Please install Buildah first."
    exit 1
fi

log_info "Buildah version: $(buildah --version)"

# ============================================================================
# Build the Image
# ============================================================================

log_info "Building image: ${IMAGE_NAME}:${IMAGE_TAG}"
log_info "Base image: ${BASE_IMAGE}"

# Create a new container from the base image
container=$(buildah from --name morse-build-${IMAGE_NAME} ${BASE_IMAGE})
log_info "Created container: ${container}"

# Set up build environment
buildah config \
  --label maintainer="Morse Chat" \
  --label description="Morse Chat Server and Client" \
  --label version="0.1.0" \
  ${container}

# Install build dependencies
log_info "Installing build dependencies..."
buildah run ${container} apk add --no-cache \
  git \
  python3 \
  make \
  g++ \
  ca-certificates \
  rsync

# Create app directory
buildah run ${container} mkdir -p /app

# Mount the container to copy files
mountpoint=$(buildah mount ${container})
log_info "Mounted container at: ${mountpoint}"

# Copy application files (exclude local deps, VCS data, build output, secrets)
log_info "Copying application files..."
mkdir -p "${mountpoint}/app"
rsync -a --exclude node_modules --exclude .git --exclude .jj \
  --exclude dist --exclude ssl --exclude .env ./ "${mountpoint}/app/"

# Unmount after copying
buildah umount ${container}

# Install dependencies
log_info "Installing npm dependencies..."
buildah run ${container} sh -c "cd /app && npm install"

# Build the React client
log_info "Building React client..."
buildah run ${container} sh -c "cd /app && npm run build"

# Clean up npm cache
buildah run ${container} sh -c "cd /app && npm cache clean --force"

# Remove build dependencies
log_info "Removing build dependencies..."
buildah run ${container} apk del \
  git \
  python3 \
  make \
  g++ \
  rsync

# Install tsx for runtime
log_info "Installing runtime dependencies..."
buildah run ${container} npm install -g tsx

# Create non-root user for security
log_info "Creating non-root user..."
buildah run ${container} adduser -D -s /bin/sh morseuser
buildah run ${container} chown -R morseuser:morseuser /app

# Configure the container
buildah config \
  --user morseuser \
  --workingdir /app \
  --env NODE_ENV=production \
  --port ${SERVER_PORT} \
  ${container}

# Set entrypoint
buildah config --entrypoint '["tsx", "morse-relais.ts", "server", "--port", "7002", "--name", "docker-server"]' \
  ${container}

# Commit the container to an image
log_info "Committing image..."
buildah commit ${container} ${IMAGE_NAME}:${IMAGE_TAG}

# Clean up
cleanup

log_info "Successfully built: ${IMAGE_NAME}:${IMAGE_TAG}"

# ============================================================================
# Push to Registry (optional)
# ============================================================================

if [ -n "${REGISTRY}" ]; then
    FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
    log_info "Pushing to registry: ${FULL_IMAGE}"

    if ! buildah push ${IMAGE_NAME}:${IMAGE_TAG} docker://${FULL_IMAGE}; then
        log_error "Failed to push image to registry"
        exit 1
    fi

    log_info "Successfully pushed: ${FULL_IMAGE}"
fi

# ============================================================================
# Output Instructions
# ============================================================================

cat <<EOF

${GREEN}================================================================================${NC}
${GREEN}  Build Complete!${NC}
${GREEN}================================================================================${NC}

Image: ${IMAGE_NAME}:${IMAGE_TAG}

To run the container:

  Using podman:
    podman run -d --name morse-app -p 7002:7002 ${IMAGE_NAME}:${IMAGE_TAG}

  Using docker:
    docker run -d --name morse-app -p 7002:7002 ${IMAGE_NAME}:${IMAGE_TAG}

Access the application:
  - WebSocket: ws://localhost:7002
  - Health:    http://localhost:7002/health

With custom configuration:
  docker run -d --name morse-app \\
    -p 7002:7002 \\
    ${IMAGE_NAME}:${IMAGE_TAG} \\
    server --port 7002 --name my-server --admin-token my-secret

${GREEN}================================================================================${NC}
EOF
