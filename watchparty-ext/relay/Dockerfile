# Relay for the WatchParty Sync extension.
#
#   docker build -t wp-relay ./relay
#   docker run -p 8787:8787 wp-relay
#
# Terminates plain ws:// on the container port. Put a TLS-terminating proxy in
# front (Fly/Render/Railway/nginx/caddy all do this) and connect from the
# extension with wss://<your-domain>.

FROM node:22-alpine

WORKDIR /app

# Dependencies install first so the layer survives code-only edits.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

# Health check against the same endpoint platforms probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
