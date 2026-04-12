#!/bin/bash
set -e

echo "========================================="
echo "  ax-builder 설치 스크립트"
echo "========================================="

# 1. Check prerequisites
echo ""
echo "[1/7] 필수 프로그램 확인..."

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
# 2. Backend dependencies
echo ""
echo "[2/7] 백엔드 의존성 설치..."
if [ -d "backend" ]; then
  cd backend && npm install && cd ..
  echo "✅ 백엔드 의존성 설치 완료"
else
  echo "⚠️  backend/ 디렉토리가 없습니다"
fi

# 3. Frontend dependencies
echo ""
echo "[3/7] 프론트엔드 의존성 설치..."
if [ -d "frontend" ]; then
  cd frontend && npm install && cd ..
  echo "✅ 프론트엔드 의존성 설치 완료"
else
  echo "⚠️  frontend/ 디렉토리가 없습니다"
fi

# 4. Hermes Agent
echo ""
echo "[4/7] Hermes Agent 설치..."
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

# 5. Hermes Python 경로 자동 감지 → .env에 기록
echo ""
echo "[5/7] Hermes Agent Python 경로 감지..."

HERMES_PYTHON=""

# 감지 순서: ~/.hermes/hermes-agent/venv → hermes CLI에서 추출 → 일반 python3
if [ -f "$HOME/.hermes/hermes-agent/venv/bin/python3" ]; then
  HERMES_PYTHON="$HOME/.hermes/hermes-agent/venv/bin/python3"
elif command -v hermes >/dev/null 2>&1; then
  # hermes가 symlink인 경우 실제 경로 추적
  HERMES_BIN=$(readlink -f "$(which hermes)" 2>/dev/null || realpath "$(which hermes)" 2>/dev/null || echo "")
  if [ -n "$HERMES_BIN" ]; then
    HERMES_DIR=$(dirname "$(dirname "$HERMES_BIN")")
    if [ -f "$HERMES_DIR/venv/bin/python3" ]; then
      HERMES_PYTHON="$HERMES_DIR/venv/bin/python3"
    fi
  fi
fi

if [ -n "$HERMES_PYTHON" ]; then
  # import 테스트
  if $HERMES_PYTHON -c "from run_agent import AIAgent; print('ok')" 2>/dev/null | grep -q "ok"; then
    echo "✅ Hermes Python 감지됨: $HERMES_PYTHON"
  else
    echo "⚠️  Hermes Python 경로는 찾았으나 AIAgent import 실패"
    echo "    경로: $HERMES_PYTHON"
    echo "    hermes setup을 먼저 실행해주세요"
  fi
else
  echo "⚠️  Hermes Python 경로를 찾을 수 없습니다"
  echo "    Hermes 설치 후 다시 실행하거나, .env에 HERMES_PYTHON_PATH를 직접 입력하세요"
fi

# 6. Environment file
echo ""
echo "[6/7] 환경 변수 파일 확인..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✅ .env 파일 생성됨"
fi

# HERMES_PYTHON_PATH를 .env에 자동 기록
if [ -n "$HERMES_PYTHON" ]; then
  if grep -q "^HERMES_PYTHON_PATH=" .env; then
    # 이미 있으면 업데이트
    sed -i.bak "s|^HERMES_PYTHON_PATH=.*|HERMES_PYTHON_PATH=$HERMES_PYTHON|" .env && rm -f .env.bak
  else
    # 없으면 추가
    echo "HERMES_PYTHON_PATH=$HERMES_PYTHON" >> .env
  fi
  echo "✅ HERMES_PYTHON_PATH가 .env에 설정됨"
fi

echo ""
echo "   수정이 필요한 값:"
echo "   • GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET"
echo "   • GEMINI_API_KEY"
echo "   • JWT_SECRET"

# 7. Data + Projects directory
echo ""
echo "[7/7] 디렉토리 생성..."
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
echo "  2. hermes setup  (Hermes 초기 설정 — 최초 1회)"
echo "  3. claude login  (Claude Code CLI 로그인 — 최초 1회)"
echo "  4. cd backend && npm run start:dev  (백엔드 시작)"
echo "  5. cd frontend && npm run dev  (프론트엔드 시작)"
echo "  6. http://localhost:5173 접속"
echo ""
