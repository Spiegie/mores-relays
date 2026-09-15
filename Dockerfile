# Dockerfile for Morse Chat
# Multi-stage build for production

# ============================================================================
# Stage 1: Builder - Install dependencies and build the application
# ============================================================================
FROM node:20-alpine AS builder

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source files (.dockerignore excludes node_modules, .git, .jj, dist)
COPY . .

# Build the React client
RUN npm run build

# ============================================================================
# Stage 2: Production - Minimal image with only runtime dependencies
# ============================================================================
FROM node:20-alpine AS production

# tsx is needed to run the TypeScript server
RUN npm install -g tsx

# Create non-root user for security
RUN adduser -D -s /bin/sh morseuser

# Create app directory
WORKDIR /app

# Copy only what the server needs from the builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/morse-relais.ts ./
COPY --from=builder /app/dist ./dist

# Change ownership to non-root user
RUN chown -R morseuser:morseuser /app

# Switch to non-root user
USER morseuser

# Set environment variables
ENV NODE_ENV=production

# Expose WebSocket/HTTP port
EXPOSE 7002

# Health check against the HTTP health endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:7002/health || exit 1

# Default: start the server (args can override the name/token)
ENTRYPOINT ["tsx", "morse-relais.ts"]
CMD ["server", "--port", "7002", "--name", "docker-server"]
