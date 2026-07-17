# 台灣人口年齡地圖 — 純靜態站，nginx 直接服務 web/
FROM nginx:alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY web/ /usr/share/nginx/html/
EXPOSE 80
