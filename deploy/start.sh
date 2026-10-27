#!/bin/sh
# Container entrypoint. With STORE_DIR (a Cloud Storage bucket mounted by Cloud Run),
# the folders the dashboard writes, and .env with the tokens, live in the bucket so
# they outlive the container. The first start seeds characters/ and series/ from the image.
set -e
cd /app
if [ -n "$STORE_DIR" ]; then
  for d in data episodes output characters series; do
    if [ ! -e "$STORE_DIR/$d" ]; then
      if [ -d "$d" ]; then cp -r "$d" "$STORE_DIR/$d"; else mkdir -p "$STORE_DIR/$d"; fi
    fi
    rm -rf "$d"
    ln -s "$STORE_DIR/$d" "$d"
  done
  if [ -f "$STORE_DIR/.env" ]; then ln -sf "$STORE_DIR/.env" .env; fi
fi
exec node packages/dashboard/dist/cli.js "$@"
