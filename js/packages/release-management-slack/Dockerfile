FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY lib ./lib
USER node
CMD ["node", "lib/main.js"]
