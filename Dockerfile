# The dashboard as a container for Cloud Run. See docs/cloud.md.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm ci && npm run build && npm prune --omit=dev
COPY channels.yaml ./
COPY characters ./characters
COPY series ./series
COPY deploy/start.sh ./deploy/start.sh
RUN mkdir -p episodes data output
ENV HOST=0.0.0.0 PORT=8080
ENTRYPOINT ["sh", "deploy/start.sh"]
