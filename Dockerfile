FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY backend/package.json ./
RUN npm install --omit=dev

# Copy application code
COPY backend/src ./src
COPY backend/start.sh ./start.sh
RUN chmod +x start.sh
COPY frontend ./frontend
COPY database ./database

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["./start.sh"]
