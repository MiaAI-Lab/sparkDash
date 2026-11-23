#!/bin/bash

set -e

# Keep the existing service running until its replacement image and frontend are ready.
echo "Building image..."
if ! docker compose build; then
  echo "Default image build failed; retrying with the official Node image from Docker Hub..."
  docker compose build --build-arg NODE_IMAGE=node:22-bookworm-slim
fi

# Compose mounts the host's dist over the image, so update it from the same
# image rather than relying on the host's Node version or an old frontend.
echo "Updating frontend bundle..."
image=$(docker compose config --images)
container_id=$(docker create "$image")
trap 'docker rm -f "$container_id" >/dev/null 2>&1 || true' EXIT
mkdir -p dist
docker cp "$container_id:/app/dist/." ./dist/
docker rm "$container_id" >/dev/null
trap - EXIT

echo "Starting service..."
docker compose up -d --no-build

echo "✅ All done! Services are now running."
