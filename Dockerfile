FROM node:22.23.1-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

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

# Production verification and runtime health inspect the packaged migration
# catalogue as the unprivileged node user. Normalize read/traverse permissions
# inside the image so restrictive checkout metadata cannot make a safe release
# fail verification after migrations have already succeeded.
RUN chmod a+rx /app/db /app/db/migrations \
    && find /app/db/migrations -type d -exec chmod a+rx {} + \
    && find /app/db/migrations -type f -exec chmod a+r {} +

USER node
EXPOSE 3030

# Do not inherit the node:alpine docker-entrypoint wrapper. CAPTAiNFiN's
# Compose services provide their own explicit commands (app/workers/migrate),
# and invoking those commands directly avoids the wrapper terminating the
# long-running worker processes during production startup.
ENTRYPOINT []
CMD ["node", "src/application.js"]
