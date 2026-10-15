#!/bin/bash
echo "===== Nginx 配置检查 ====="
ssh -o StrictHostKeyChecking=no root@60.205.214.88 "
echo '--- 站点配置文件 ---'
cat /www/server/panel/vhost/nginx/html_img.fangkelianmeng.com.conf

echo ''
echo '--- 检查 SSL 证书 ---'
ls -la /www/server/panel/vhost/cert/img.fangkelianmeng.com/ 2>/dev/null || echo 'No SSL cert dir'

echo ''
echo '--- 检查 HTTPS 监听 ---'
grep -n 'listen\|ssl\|server_name' /www/server/panel/vhost/nginx/html_img.fangkelianmeng.com.conf
"

echo ""
echo "===== 测试 HTTPS 访问 ====="
curl -sI https://img.fangkelianmeng.com/ 2>&1 | head -10

echo ""
echo "===== 测试 HTTP 访问 ====="
curl -sI http://img.fangkelianmeng.com/ 2>&1 | head -10
