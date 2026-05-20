FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY deploy/remote-pwa/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/dist/ /usr/share/nginx/html/

EXPOSE 8080
