FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY src ./src
COPY certs ./certs

EXPOSE 8443

CMD ["npm", "run", "start"]
