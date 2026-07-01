<?php
/**
 * 플레이스 트래픽 캠페인 관리
 * 위치: dnotraffic.com/place_traffic.php
 * 접근: 그누보드 최고관리자만
 */

require_once('./_common.php');

if (!is_admin('super')) {
    alert('관리자만 접근 가능합니다.');
    exit;
}

define('TABLE', $g5['table_prefix'] . 'place_campaign');

// 테이블 없으면 자동 생성
$sql = "CREATE TABLE IF NOT EXISTS " . TABLE . " (
    id int(11) NOT NULL AUTO_INCREMENT,
    place_id varchar(50) NOT NULL,
    place_name varchar(100) NOT NULL DEFAULT '',
    keyword varchar(200) NOT NULL DEFAULT '',
    daily_count int(11) NOT NULL DEFAULT 100,
    is_active tinyint(1) NOT NULL DEFAULT 1,
    created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4";
sql_query($sql);

$msg = '';

// ── 처리 ────────────────────────────────────────────
$act = $_POST['act'] ?? $_GET['act'] ?? '';

if ($act === 'add') {
    $place_id    = trim($_POST['place_id'] ?? '');
    $place_name  = trim($_POST['place_name'] ?? '');
    $keyword     = trim($_POST['keyword'] ?? '');
    $daily_count = (int)($_POST['daily_count'] ?? 100);
    if ($place_id && $keyword) {
        $sql = "INSERT INTO " . TABLE . " (place_id, place_name, keyword, daily_count) VALUES ('".addslashes($place_id)."', '".addslashes($place_name)."', '".addslashes($keyword)."', $daily_count)";
        sql_query($sql);
        $msg = '업체가 등록되었습니다.';
    } else {
        $msg = '플레이스 ID와 키워드를 입력해주세요.';
    }
} elseif ($act === 'del') {
    $id = (int)($_GET['id'] ?? 0);
    if ($id) sql_query("DELETE FROM " . TABLE . " WHERE id=$id");
    header('Location: place_traffic.php'); exit;
} elseif ($act === 'toggle') {
    $id = (int)($_GET['id'] ?? 0);
    if ($id) sql_query("UPDATE " . TABLE . " SET is_active = 1 - is_active WHERE id=$id");
    header('Location: place_traffic.php'); exit;
} elseif ($act === 'edit') {
    $id          = (int)($_POST['id'] ?? 0);
    $place_id    = trim($_POST['place_id'] ?? '');
    $place_name  = trim($_POST['place_name'] ?? '');
    $keyword     = trim($_POST['keyword'] ?? '');
    $daily_count = (int)($_POST['daily_count'] ?? 100);
    if ($id && $place_id && $keyword) {
        $sql = "UPDATE " . TABLE . " SET place_id='".addslashes($place_id)."', place_name='".addslashes($place_name)."', keyword='".addslashes($keyword)."', daily_count=$daily_count WHERE id=$id";
        sql_query($sql);
        $msg = '수정되었습니다.';
    }
}

// 수정 폼용 데이터
$edit_row = null;
if (isset($_GET['edit_id'])) {
    $eid = (int)$_GET['edit_id'];
    $edit_row = sql_fetch("SELECT * FROM " . TABLE . " WHERE id=$eid");
}

// 목록
$rows = [];
$res = sql_query("SELECT * FROM " . TABLE . " ORDER BY id DESC");
while ($r = sql_fetch_array($res)) $rows[] = $r;
?>
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>플레이스 트래픽 캠페인 관리</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Noto Sans KR',sans-serif;background:#f0f2f5;color:#222;font-size:14px}
.wrap{max-width:900px;margin:30px auto;padding:0 16px}
h1{font-size:20px;font-weight:700;margin-bottom:20px;color:#111}
.card{background:#fff;border-radius:10px;padding:24px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.card h2{font-size:15px;font-weight:600;margin-bottom:16px;color:#333;border-bottom:1px solid #eee;padding-bottom:10px}
.form-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px}
.form-group{display:flex;flex-direction:column;gap:4px}
.form-group label{font-size:12px;color:#666;font-weight:500}
.form-group input{border:1px solid #ddd;border-radius:6px;padding:8px 10px;font-size:13px;width:100%}
.form-group.wide input{width:220px}
.form-group.sm input{width:90px}
.btn{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
.btn-primary{background:#1a73e8;color:#fff}
.btn-primary:hover{background:#1558b0}
.btn-danger{background:#ea4335;color:#fff}
.btn-warn{background:#f9ab00;color:#fff}
.btn-sm{padding:4px 10px;font-size:12px;border-radius:4px}
table{width:100%;border-collapse:collapse}
th{background:#f8f9fa;padding:10px 12px;text-align:left;font-size:12px;color:#555;border-bottom:2px solid #eee}
td{padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;vertical-align:middle}
tr:hover td{background:#fafafa}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}
.badge-on{background:#e6f4ea;color:#137333}
.badge-off{background:#fce8e6;color:#c5221f}
.msg{padding:10px 14px;border-radius:6px;margin-bottom:16px;background:#e8f0fe;color:#1a73e8;font-size:13px}
.actions{display:flex;gap:6px}
.api-url{background:#f8f9fa;border:1px solid #e0e0e0;border-radius:6px;padding:10px 14px;font-size:12px;font-family:monospace;color:#333;word-break:break-all}
</style>
</head>
<body>
<div class="wrap">
<h1>📍 플레이스 트래픽 캠페인 관리</h1>

<?php if ($msg): ?>
<div class="msg"><?= htmlspecialchars($msg) ?></div>
<?php endif; ?>

<!-- 업체 등록 / 수정 폼 -->
<div class="card">
    <h2><?= $edit_row ? '✏️ 업체 수정' : '➕ 업체 등록' ?></h2>
    <form method="post" action="place_traffic.php">
        <input type="hidden" name="act" value="<?= $edit_row ? 'edit' : 'add' ?>">
        <?php if ($edit_row): ?><input type="hidden" name="id" value="<?= $edit_row['id'] ?>"><?php endif; ?>
        <div class="form-row">
            <div class="form-group wide">
                <label>플레이스 ID (URL 숫자)</label>
                <input type="text" name="place_id" placeholder="예: 18000102" required value="<?= htmlspecialchars($edit_row['place_id'] ?? '') ?>">
            </div>
            <div class="form-group wide">
                <label>업체명 (메모용)</label>
                <input type="text" name="place_name" placeholder="예: 불광사" value="<?= htmlspecialchars($edit_row['place_name'] ?? '') ?>">
            </div>
            <div class="form-group wide">
                <label>검색 키워드</label>
                <input type="text" name="keyword" placeholder="예: 경기도 불광사" required value="<?= htmlspecialchars($edit_row['keyword'] ?? '') ?>">
            </div>
            <div class="form-group sm">
                <label>하루 방문수</label>
                <input type="number" name="daily_count" min="1" max="1000" value="<?= $edit_row['daily_count'] ?? 100 ?>">
            </div>
            <div class="form-group">
                <label>&nbsp;</label>
                <button type="submit" class="btn btn-primary"><?= $edit_row ? '수정 저장' : '등록' ?></button>
            </div>
            <?php if ($edit_row): ?>
            <div class="form-group">
                <label>&nbsp;</label>
                <a href="place_traffic.php" class="btn btn-warn">취소</a>
            </div>
            <?php endif; ?>
        </div>
        <p style="font-size:11px;color:#999;margin-top:6px">
            플레이스 ID: naver.me 또는 pcmap.place.naver.com/place/<strong>여기숫자</strong>/home
        </p>
    </form>
</div>

<!-- 등록 업체 목록 -->
<div class="card">
    <h2>📋 등록 업체 목록 (총 <?= count($rows) ?>개)</h2>
    <?php if (empty($rows)): ?>
    <p style="color:#999;text-align:center;padding:20px">등록된 업체가 없습니다.</p>
    <?php else: ?>
    <table>
        <thead>
            <tr>
                <th>#</th>
                <th>업체명</th>
                <th>플레이스 ID</th>
                <th>키워드</th>
                <th>하루방문수</th>
                <th>상태</th>
                <th>관리</th>
            </tr>
        </thead>
        <tbody>
        <?php foreach ($rows as $r): ?>
        <tr>
            <td><?= $r['id'] ?></td>
            <td><strong><?= htmlspecialchars($r['place_name'] ?: '-') ?></strong></td>
            <td><code><?= htmlspecialchars($r['place_id']) ?></code></td>
            <td><?= htmlspecialchars($r['keyword']) ?></td>
            <td style="text-align:center"><?= number_format($r['daily_count']) ?>회</td>
            <td>
                <span class="badge <?= $r['is_active'] ? 'badge-on' : 'badge-off' ?>">
                    <?= $r['is_active'] ? '활성' : '중지' ?>
                </span>
            </td>
            <td>
                <div class="actions">
                    <a href="place_traffic.php?edit_id=<?= $r['id'] ?>" class="btn btn-warn btn-sm">수정</a>
                    <a href="place_traffic.php?act=toggle&id=<?= $r['id'] ?>" class="btn btn-sm" style="background:#34a853;color:#fff"><?= $r['is_active'] ? '중지' : '활성' ?></a>
                    <a href="place_traffic.php?act=del&id=<?= $r['id'] ?>" class="btn btn-danger btn-sm" onclick="return confirm('삭제하시겠습니까?')">삭제</a>
                </div>
            </td>
        </tr>
        <?php endforeach; ?>
        </tbody>
    </table>
    <?php endif; ?>
</div>

<!-- API 안내 -->
<div class="card">
    <h2>🔌 워커 API 주소</h2>
    <p style="margin-bottom:10px;font-size:13px;color:#555">리눅스 워커가 이 주소에서 업체 목록을 자동으로 가져갑니다:</p>
    <div class="api-url">https://dnotraffic.com/api/place_campaigns.php?key=DNO_PLACE_2024</div>
    <p style="margin-top:10px;font-size:12px;color:#999">워커 실행: <code>DISPLAY=:99 node ~/place-traffic/campaign.js https://dnotraffic.com/api/place_campaigns.php?key=DNO_PLACE_2024 ~/place-traffic/프록시.txt 30 60</code></p>
</div>

</div>
</body>
</html>
