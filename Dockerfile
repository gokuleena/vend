FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production DB_FILE=/data/vend.db
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
