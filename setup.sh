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
if command -v docker >/dev/null 2>&1; then
  echo "✅ Docker $(docker --version | head -1)"
else
  echo "⚠️  Docker 미설치 (빌드 파이프라인에서 프로젝트 격리 실행 시 필요)"
fi

echo "✅ Node.js $(node -v)"
echo "✅ Python $(python3 --version)"

# 2. Orchestrator (NestJS) dependencies
echo ""
echo "[2/6] Orchestrator(NestJS) 의존성 설치..."
if [ -d "orchestrator" ]; then
  cd orchestrator && npm install && cd ..
  echo "✅ Orchestrator 의존성 설치 완료"
else
  echo "⚠️  orchestrator/ 디렉토리가 없습니다"
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

# 4. Planning Agent (Python) venv
echo ""
echo "[4/6] Planning Agent venv 준비..."
if [ -d "planning-agent" ]; then
  cd planning-agent
  if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo "✅ planning-agent/venv 생성됨"
  fi
  source venv/bin/activate
  if [ -f "requirements.txt" ]; then
    pip install -q -r requirements.txt
    echo "✅ Planning Agent 의존성 설치 완료"
  fi
  deactivate
  cd ..
else
  echo "⚠️  planning-agent/ 디렉토리가 없습니다 (Step 2에서 생성 예정)"
fi

# 5. Environment file
echo ""
echo "[5/6] 환경 변수 파일 확인..."
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "✅ .env 파일 생성됨"
  else
    echo "⚠️  .env.example이 없습니다"
  fi
fi

echo ""
echo "   수정이 필요한 값:"
echo "   • GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET"
echo "   • GEMINI_API_KEY 또는 OPENROUTER_API_KEY"
echo "   • JWT_SECRET"
echo "   • LLM_BACKEND (openai_compat | ollama)"
echo "   • SLOT_CHAT / SLOT_SUMMARIZE / SLOT_EVAL / SLOT_TOOL_ARG"

# 6. Data + Projects directory
echo ""
echo "[6/6] 디렉토리 생성..."
mkdir -p data
mkdir -p projects
touch projects/.gitkeep
echo "✅ data/ 디렉토리 준비 완료 (SQLite DB 저장)"
echo "✅ projects/ 디렉토리 준비 완료 (빌드된 프로젝트)"

echo ""
echo "========================================="
echo "  설치 완료!"
echo "========================================="
echo ""
echo "다음 단계:"
echo "  1. nano .env  (API 키 입력)"
echo "  2. claude login  (Claude Code CLI 로그인 — Building에 필요)"
echo "  3. pm2 start ecosystem.config.cjs  (전체 서비스 기동)"
echo ""
