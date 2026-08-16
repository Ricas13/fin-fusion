FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache postgresql-client libqrencode-tools

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY . .

USER node
EXPOSE 3030

# Do not inherit the node:alpine docker-entrypoint wrapper. CAPTaINFiN's
# Compose services provide their own explicit commands (app/workers/migrate),
# and invoking those commands directly avoids the wrapper terminating the
# long-running worker processes during production startup.
ENTRYPOINT []
CMD ["node", "src/application.js"]
