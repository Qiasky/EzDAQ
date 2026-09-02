FROM node:24-alpine
WORKDIR /opt/ezdaq
COPY package.json ./
COPY server.mjs ./
COPY public ./public
RUN mkdir -p /var/lib/ezdaq
ENV PORT=8080 EZDAQ_DATA_DIR=/var/lib/ezdaq
EXPOSE 8080
VOLUME ["/var/lib/ezdaq"]
CMD ["node", "server.mjs"]
