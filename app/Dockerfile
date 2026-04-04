# ──────────────────────────────────────────────────────────────────────
#  Genomics Viewer — single-container build
# ──────────────────────────────────────────────────────────────────────

# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Production image
FROM python:3.12-slim
WORKDIR /app

# Install Python dependencies
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend
COPY backend/ ./backend/

# Copy built frontend into backend's expected location
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

EXPOSE 8000

# Run with uvicorn — serves both API and built frontend
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "backend"]
