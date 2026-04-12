#!/bin/bash
set -e

echo "========================================="
echo "  ax-builder 설치 스크립트"
echo "========================================="

# 1. Check prerequisites
echo ""
echo "[1/6] 필수 프로그램 확인..."

command -v node >/dev/null 2>&1 || { echo "❌ Node.js가 필요합니다. https://nodejs.org"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "❌ Python 3.11+이 필요합니다. brew install python@3.11"; exit 1; }
PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.minor}")')
if [ "$PYTHON_VERSION" -lt 11 ]; then
  echo "⚠️  Python 3.11+ 필요 (현재 3.$PYTHON_VERSION). brew install python@3.11"
fi
command -v docker >/dev/null 2>&1 || { echo "❌ Docker가 필요합니다. https://docker.com"; exit 1; }

echo "✅ Node.js $(node -v)"
echo "✅ Python $(python3 --version)"
echo "✅ Docker $(docker --version | head -1)"

# 2. Backend dependencies
echo ""
echo "[2/6] 백엔드 의존성 설치..."
if [ -d "backend" ]; then
  cd backend && npm install && cd ..
  echo "✅ 백엔드 의존성 설치 완료"
else
  echo "⚠️  backend/ 디렉토리가 없습니다"
fi

# 3. Frontend dependencies
echo ""
echo "[3/6] 프론트엔드 의존성 설치..."
if [ -d "frontend" ]; then
  cd frontend && npm install && cd ..
  echo "✅ 프론트엔드 의존성 설치 완료"
else
  echo "⚠️  frontend/ 디렉토리가 없습니다"
fi

# 4. Hermes Agent
echo ""
echo "[4/6] Hermes Agent 설치..."
if command -v hermes >/dev/null 2>&1; then
  echo "✅ Hermes Agent 이미 설치됨 ($(hermes --version 2>/dev/null || echo 'version unknown'))"
else
  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash && {
    echo "✅ Hermes Agent 설치 완료"
  } || {
    echo "⚠️  Hermes Agent 설치 실패 (빌드 기능에 필요)"
    echo "    수동: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"
  }
fi

# 5. Environment file
echo ""
echo "[5/6] 환경 변수 파일 확인..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✅ .env 파일 생성됨 — 아래 값을 수정하세요:"
  echo "   • GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET"
  echo "   • GEMINI_API_KEY"
  echo "   • JWT_SECRET"
else
  echo "✅ .env 파일이 이미 존재합니다"
fi

# 6. Projects directory
echo ""
echo "[6/6] 프로젝트 디렉토리 생성..."
mkdir -p projects
touch projects/.gitkeep
echo "✅ projects/ 디렉토리 준비 완료"

echo ""
echo "========================================="
echo "  설치 완료!"
echo "========================================="
echo ""
echo "다음 단계:"
echo "  1. nano .env  (API 키 입력)"
echo "  2. cd docker && docker-compose up -d  (MySQL 시작)"
echo "  3. cd backend && npm run start:dev  (백엔드 시작)"
echo "  4. cd frontend && npm run dev  (프론트엔드 시작)"
echo "  5. http://localhost:5173 접속"
echo ""
