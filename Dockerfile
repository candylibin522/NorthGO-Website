FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node build-northgo.mjs serve-northgo.mjs dispatch-northgo.mjs VERSION northgo-new.html sitemap-data.js ./
COPY --chown=node:node backend/ ./backend/
COPY --chown=node:node admin/ ./admin/
COPY --chown=node:node site-assets/ ./site-assets/
COPY --chown=node:node office-assets/ ./office-assets/
RUN mkdir -p /data/inbox /data/private && chown -R node:node /data /app
USER node
ENV NODE_ENV=production NORTHGO_HOST=0.0.0.0 PORT=4180 NORTHGO_INBOX_DIR=/data/inbox NORTHGO_DATA_DIR=/data/private
EXPOSE 4180
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "serve-northgo.mjs"]
