FROM node:22-alpine

RUN apk add --no-cache mariadb-client tzdata unzip

WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY bridge.js epubcfi.js selftest.js /app/

VOLUME /data
CMD ["node", "/app/bridge.js"]
