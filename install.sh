#!/bin/bash
# 플레이스 트래픽 자동 설치 스크립트
# 사용법: curl -fsSL [RAW_URL]/install.sh | bash
# 또는:  bash install.sh

set -e

REPO_URL="https://github.com/n1-9353/place-traffic.git"
INSTALL_DIR="$HOME/place-traffic"
DISPLAY_NUM=99

echo "================================================"
echo " 플레이스 트래픽 자동 설치"
echo "================================================"

# 시스템 패키지 업데이트
echo "[1/6] 시스템 업데이트..."
sudo apt-get update -y -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq

# Node.js 20 LTS
echo "[2/6] Node.js 설치..."
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1
  sudo apt-get install -y -qq nodejs
fi
echo "    Node.js $(node -v) / npm $(npm -v)"

# 필수 도구
echo "[3/6] 필수 도구 설치..."
sudo apt-get install -y -qq git xvfb curl unzip

# 저장소 클론 또는 업데이트
echo "[4/6] 코드 설치..."
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "    기존 설치 감지 → git pull"
  cd "$INSTALL_DIR" && git pull -q
else
  git clone -q "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# npm + Playwright 설치
echo "[5/6] Playwright 설치..."
npm install --silent --no-fund --no-audit
npx playwright install chromium --with-deps > /dev/null 2>&1
echo "    Playwright Chromium 설치 완료"

# Xvfb 서비스 등록 (headless:false용 가상 디스플레이)
echo "[6/6] 서비스 설정..."
sudo tee /etc/systemd/system/xvfb-place.service > /dev/null <<EOF
[Unit]
Description=Xvfb Virtual Display for Place Traffic
After=network.target

[Service]
ExecStart=/usr/bin/Xvfb :${DISPLAY_NUM} -screen 0 1280x800x24
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload > /dev/null 2>&1
sudo systemctl enable xvfb-place -q > /dev/null 2>&1
sudo systemctl restart xvfb-place

# DISPLAY 환경변수 자동 설정
grep -qxF "export DISPLAY=:${DISPLAY_NUM}" ~/.bashrc 2>/dev/null || \
  echo "export DISPLAY=:${DISPLAY_NUM}" >> ~/.bashrc

# 자동 업데이트 cron (5분마다 git pull)
CRON_CMD="*/5 * * * * cd ${INSTALL_DIR} && git pull -q 2>/dev/null"
(crontab -l 2>/dev/null | grep -v "place-traffic" | grep -v "place_traffic"; \
 echo "$CRON_CMD") | crontab -
echo "    자동 업데이트 등록 (5분마다 git pull)"

echo ""
echo "================================================"
echo " 설치 완료!"
echo "================================================"
echo ""
echo "실행 예시 (프록시 300개, 동시 30개):"
echo "  cd ~/place-traffic"
echo "  DISPLAY=:99 node visit_place.js 1533747405 '위례 광고' 300 60 프록시.txt 30"
echo "  DISPLAY=:99 node visit_place.js 18000102 '경기도 불광사' 300 60 프록시.txt 30"
echo ""
echo "프록시 파일은 ~/place-traffic/프록시.txt 에 넣으세요"
echo "(ip:port 형식, 한 줄에 하나)"
