#!/bin/sh
# Recreates the local container used by the API/browser tests: a bind mount with tricky file names,
# a read-only alias of the same path, a named volume, and a container without mounts.
set -e
DOCKER=${DOCKER:-docker}
DIR=${DIR:-/tmp/dpfile}

# A container's bind mount follows the inode of the host directory, so the directory must be emptied
# rather than replaced – otherwise running daemons keep seeing the old, deleted directory.
if [ -d "$DIR" ]; then find "$DIR" -mindepth 1 -delete 2>/dev/null || rm -rf "$DIR"; fi
mkdir -p "$DIR/conf.d" "$DIR/logs" "$DIR/dir with spaces"
printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n}\n' > "$DIR/nginx.conf"
printf 'hello\n' > "$DIR/dir with spaces/my file.txt"
printf '#!/bin/sh\necho hi\n' > "$DIR/run.sh"; chmod 755 "$DIR/run.sh"
printf 'binary\x00\x01\x02data' > "$DIR/blob.bin"
printf 'line %s\n' 1 2 3 4 5 > "$DIR/logs/app.log"
ln -sf nginx.conf "$DIR/link.conf"

mkdir -p "$DIR-single" && printf 'worker_processes 1;\n' > "$DIR-single/app.conf" && chmod 640 "$DIR-single/app.conf"

$DOCKER rm -f dp-demo-files dp-demo-files-vol dp-demo-nomount dp-demo-singlefile >/dev/null 2>&1 || true
$DOCKER run -d --name dp-demo-files -v "$DIR:/etc/dp:rw" -v "$DIR:/etc/ro:ro" alpine sleep infinity >/dev/null
$DOCKER volume create dp-demo-vol >/dev/null
$DOCKER run -d --name dp-demo-files-vol -v dp-demo-vol:/data alpine sleep infinity >/dev/null
$DOCKER run -d --name dp-demo-nomount alpine sleep infinity >/dev/null
$DOCKER run -d --name dp-demo-singlefile -v "$DIR-single/app.conf:/etc/app/app.conf" alpine sleep infinity >/dev/null
echo "fixtures ready in $DIR"
