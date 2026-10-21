FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0

# Only runtime files enter the image; no dependency installation is needed.
COPY --chown=node:node package.json index.html privacy.html terms.html sw.js ./
COPY --chown=node:node js/ ./js/
COPY --chown=node:node styles/ ./styles/
COPY --chown=node:node assets/ ./assets/
COPY --chown=node:node banks/ ./banks/
COPY --chown=node:node tools/serve.mjs tools/local-db.mjs ./tools/
COPY --chown=node:node server/ ./server/
COPY --chown=node:node migrations/0002_restore.sql migrations/0005_api_maintenance.sql ./migrations/
RUN mkdir /data && chown node:node /data
ENV LOCAL_DB_PATH=/data/quitsar.sqlite

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http=require('node:http');const r=http.get('http://127.0.0.1:8080/',s=>{s.resume();process.exit(s.statusCode===200?0:1)});r.setTimeout(2000,()=>r.destroy());r.on('error',()=>process.exit(1));"

CMD ["node", "tools/serve.mjs"]
