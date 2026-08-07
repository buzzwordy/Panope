# Build renderer + server, then ship only what is needed to run.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# helm is optional - the Charts/Releases views degrade gracefully without it
RUN apk add --no-cache helm || true
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/out/server ./out/server
COPY --from=build /app/out/renderer ./out/renderer
# AGPL-3.0 obliges us to convey the license with the work, and the bundled
# icon paths carry MIT/ISC notices that must travel with any redistribution.
COPY LICENSE THIRD-PARTY-NOTICES.md ./
ENV PANOPE_STATIC=/app/out/renderer
# never run as root; the ServiceAccount token is all the identity this needs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "out/server/server/index.js"]
