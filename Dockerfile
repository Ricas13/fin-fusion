FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache postgresql-client

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

USER node
EXPOSE 3030
CMD ["npm", "start"]
