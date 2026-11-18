# ---- stage 1: fetch the hls.js browser player ---------------------------------
# The server itself has no npm dependencies. hls.js is the only third-party
# code, and it is baked into the image so the app never needs a CDN at runtime.
FROM node:22-alpine AS vendor
WORKDIR /tmp/vendor
RUN npm pack hls.js@1 --silent \
 && tar -xzf hls.js-*.tgz package/dist/hls.min.js

# ---- stage 2: runtime ----------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app

COPY package.json ./
COPY server ./server
COPY views ./views
COPY public ./public
COPY --from=vendor /tmp/vendor/package/dist/hls.min.js ./public/vendor/hls.min.js

# 99:100 is nobody:users, the owner Unraid uses for appdata shares.
RUN mkdir -p /data && chown 99:100 /data
USER 99:100
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
