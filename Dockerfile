FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

ARG CAPTAINFIN_BUILD_SHA=unknown
ARG CAPTAINFIN_BUILD_TIME=unknown
ENV CAPTAINFIN_BUILD_SHA=${CAPTAINFIN_BUILD_SHA} \
    CAPTAINFIN_BUILD_TIME=${CAPTAINFIN_BUILD_TIME}

RUN apk add --no-cache postgresql-client libqrencode-tools

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY . .

USER node
EXPOSE 3030

# Do not inherit the node:alpine docker-entrypoint wrapper. CAPTAiNFiN's
# Compose services provide their own explicit commands (app/workers/migrate),
# and invoking those commands directly avoids the wrapper terminating the
# long-running worker processes during production startup.
ENTRYPOINT []
CMD ["node", "src/application.js"]
