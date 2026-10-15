#!/bin/bash
echo "===== 1. 模拟浏览器完整请求（带 Origin）====="
curl -s -w "\nHTTP_CODE:%{http_code}\n" \
  -H "Origin: https://img.fangkelianmeng.com" \
  -H "Referer: https://img.fangkelianmeng.com/" \
  'https://api.xuyiheng.com/api/v1/front/antucao/image/sample?mainUrl=img.fangkelianmeng.com&pageSize=3' \
  -D /tmp/headers.txt -o /tmp/body.txt
echo "--- Response Headers ---"
cat /tmp/headers.txt | grep -iE "access-control|content-type|HTTP"
echo "--- Response Body (first 200 chars) ---"
head -c 200 /tmp/body.txt
echo ""

echo ""
echo "===== 2. 检查 DNS 解析 ====="
getent hosts img.fangkelianmeng.com 2>/dev/null || echo "DNS resolution failed"
getent hosts api.xuyiheng.com 2>/dev/null || echo "API DNS resolution failed"

echo ""
echo "===== 3. 检查 Nginx 配置 ====="
ssh -o StrictHostKeyChecking=no root@60.205.214.88 "
echo '--- Nginx sites for img.fangkelianmeng ---'
grep -rl 'img.fangkelianmeng' /www/server/panel/vhost/nginx/ 2>/dev/null | head -5
echo '--- Check if site config exists ---'
ls -la /www/server/panel/vhost/nginx/img.fangkelianmeng.com.conf 2>/dev/null || echo 'No vhost config found'
echo '--- Default site check ---'
grep -l 'img.fangkelianmeng' /www/server/nginx/conf/nginx.conf 2>/dev/null || echo 'Not in main nginx.conf'
"

echo ""
echo "===== 4. 从目标服务器直接测试 API ====="
ssh -o StrictHostKeyChecking=no root@60.205.214.88 "
curl -s -H 'Origin: https://img.fangkelianmeng.com' \
  'https://api.xuyiheng.com/api/v1/front/antucao/image/sample?mainUrl=img.fangkelianmeng.com&pageSize=2' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(\"code:\", d.get(\"code\"), \"list_len:\", len(d.get(\"data\",{}).get(\"list\",[])))'
"
