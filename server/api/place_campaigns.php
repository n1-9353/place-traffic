<?php
/**
 * 플레이스 캠페인 API
 * 위치: dnotraffic.com/api/place_campaigns.php
 * 워커가 이 URL을 호출해서 활성 캠페인 목록을 가져감
 *
 * 사용법: GET /api/place_campaigns.php?key=DNO_PLACE_2024
 * 응답: [{"placeId":"...","keyword":"...","count":100}, ...]
 */

define('SECRET_KEY', 'DNO_PLACE_2024');

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

// 인증
if (($_GET['key'] ?? '') !== SECRET_KEY) {
    http_response_code(403);
    echo json_encode(['error' => 'forbidden']);
    exit;
}

// DB 연결 (그누보드 dbconfig.php 사용)
$config_path = dirname(dirname(__FILE__)) . '/data/dbconfig.php';
if (!file_exists($config_path)) {
    http_response_code(500);
    echo json_encode(['error' => 'db config not found']);
    exit;
}
require_once($config_path);

$db = new mysqli(G5_DB_HOST, G5_DB_USER, G5_DB_PASSWORD, G5_DB_NAME);
if ($db->connect_error) {
    http_response_code(500);
    echo json_encode(['error' => 'db connect failed']);
    exit;
}
$db->set_charset('utf8mb4');

// 활성 캠페인 조회
$result = $db->query("SELECT place_id, place_name, keyword, daily_count FROM " . G5_TABLE_PREFIX . "place_campaign WHERE is_active = 1 ORDER BY id ASC");

if (!$result) {
    http_response_code(500);
    echo json_encode(['error' => 'query failed: ' . $db->error]);
    exit;
}

$campaigns = [];
while ($row = $result->fetch_assoc()) {
    $campaigns[] = [
        'placeId' => $row['place_id'],
        'keyword' => $row['keyword'],
        'count'   => (int)$row['daily_count'],
        'name'    => $row['place_name'],
    ];
}

$db->close();
echo json_encode($campaigns, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
