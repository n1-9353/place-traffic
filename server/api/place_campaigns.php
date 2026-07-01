<?php
/**
 * 플레이스 캠페인 API - 워커용
 * GET /api/place_campaigns.php?key=DNO_PLACE_2024
 */
$sk = 'DNO_PLACE_2024';
if (($_GET['key'] ?? '') !== $sk) {
    http_response_code(403);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":"forbidden"}';
    exit;
}

// gnuboard common 로드 (직접 mysqli 대신 gnuboard DB 함수 사용)
if (!defined('_GNUBOARD_')) define('_GNUBOARD_', true);
$root = dirname(dirname(__FILE__));
require_once($root . '/common.php');

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

$tbl = $g5['table_prefix'] . 'place_campaign';
$res = sql_query("SELECT place_id, place_name, keyword, daily_count FROM `{$tbl}` WHERE is_active = 1 ORDER BY id ASC");
$out = [];
while ($r = sql_fetch_array($res)) {
    $out[] = [
        'placeId'  => $r['place_id'],
        'keyword'  => $r['keyword'],
        'count'    => (int)$r['daily_count'],
        'name'     => $r['place_name'],
    ];
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
