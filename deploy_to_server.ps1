# 플레이스 트래픽 서버 파일 FTP 배포
# dnotraffic.com에 place_traffic.php + api/place_campaigns.php 업로드
#
# 사용법: .\deploy_to_server.ps1

# ── DB 비밀번호 읽기 (dbconfig.php에서) ──────────────
$dbconfigPath = "C:\Users\User\OneDrive\바탕 화면\workspace\connector\data\dbconfig.php"
if (-not (Test-Path $dbconfigPath)) {
    Write-Host "dbconfig.php를 찾을 수 없습니다: $dbconfigPath" -ForegroundColor Red
    exit 1
}
$content = Get-Content $dbconfigPath -Raw
if ($content -match "G5_MYSQL_PASSWORD['\s,]+['`"]([^'`"]+)") {
    $ftpPass = $Matches[1]
} else {
    Write-Host "비밀번호를 읽지 못했습니다. dbconfig.php 확인 필요" -ForegroundColor Red
    exit 1
}

$ftpUser = "trafficvisit"
$ftpHost = "ftp.dnotraffic.com"
$localDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── 업로드 함수 ───────────────────────────────────────
function Upload-File($localFile, $remotePath) {
    $url = "ftp://${ftpHost}/${remotePath}"
    $request = [System.Net.FtpWebRequest]::Create($url)
    $request.Method = [System.Net.WebRequestMethods+Ftp]::UploadFile
    $request.Credentials = New-Object System.Net.NetworkCredential($ftpUser, $ftpPass)
    $request.UseBinary = $true
    $request.UsePassive = $true
    $request.KeepAlive = $false
    $bytes = [System.IO.File]::ReadAllBytes($localFile)
    $request.ContentLength = $bytes.Length
    $stream = $request.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $response = $request.GetResponse()
    $response.Close()
    Write-Host "  ✅ 업로드: $remotePath" -ForegroundColor Green
}

function Create-Dir($remotePath) {
    try {
        $url = "ftp://${ftpHost}/${remotePath}"
        $request = [System.Net.FtpWebRequest]::Create($url)
        $request.Method = [System.Net.WebRequestMethods+Ftp]::MakeDirectory
        $request.Credentials = New-Object System.Net.NetworkCredential($ftpUser, $ftpPass)
        $request.UsePassive = $true
        $response = $request.GetResponse()
        $response.Close()
        Write-Host "  📁 폴더 생성: $remotePath" -ForegroundColor Cyan
    } catch {
        # 이미 존재하면 무시
    }
}

# ── 배포 ─────────────────────────────────────────────
Write-Host ""
Write-Host "================================" -ForegroundColor Cyan
Write-Host " dnotraffic.com FTP 배포 시작" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

try {
    # place_traffic.php → 루트
    Upload-File "$localDir\server\place_traffic.php" "www/place_traffic.php"

    # api/ 폴더 생성 (없을 경우 대비)
    Create-Dir "www/api"

    # api/place_campaigns.php
    Upload-File "$localDir\server\api\place_campaigns.php" "www/api/place_campaigns.php"

    Write-Host ""
    Write-Host "================================" -ForegroundColor Green
    Write-Host " 배포 완료!" -ForegroundColor Green
    Write-Host "================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "관리 페이지: https://dnotraffic.com/place_traffic.php" -ForegroundColor Yellow
    Write-Host "API 주소:    https://dnotraffic.com/api/place_campaigns.php?key=DNO_PLACE_2024" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "리눅스 실행 명령:" -ForegroundColor Cyan
    Write-Host "  DISPLAY=:99 node ~/place-traffic/campaign.js \"https://dnotraffic.com/api/place_campaigns.php?key=DNO_PLACE_2024\" ~/place-traffic/프록시.txt 30 60" -ForegroundColor White

} catch {
    Write-Host "❌ 오류: $_" -ForegroundColor Red
}
