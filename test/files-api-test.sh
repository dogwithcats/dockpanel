#!/bin/sh
# End-to-end checks for the container file API. Requires a running panel and test/fixtures.sh.
#   BASE=http://localhost:8090 PANEL_PASSWORD=test123 ./test/files-api-test.sh
set -e
BASE=${BASE:-http://localhost:8090}
JAR=${JAR:-/tmp/dp-test-cookies}
HOST_ID=${HOST_ID:-local}
C=${CONTAINER:-dp-demo-files}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  \033[31m✗\033[0m %s\n    → %s\n' "$1" "$2"; }
check(){ # check <name> <actual> <expected-substring>
  case "$2" in *"$3"*) ok "$1";; *) bad "$1" "$2";; esac
}
api(){ curl -s -b "$JAR" "$@"; }
files(){ api "$BASE/api/hosts/$HOST_ID/containers/$C/files$1"; }

curl -s -c "$JAR" -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"${PANEL_USER:-admin}\",\"password\":\"${PANEL_PASSWORD:-test123}\"}" >/dev/null

echo "mounts"
M=$(files /mounts)
check "writable mount listed first" "$M" '"target":"/etc/dp"'
check "read-only mount marked"       "$M" '"rw":false'

echo "listing"
L=$(files '/entries?mount=/etc/dp&path=')
check "regular file"        "$L" '"name":"nginx.conf"'
check "directory"           "$L" '"name":"conf.d"'
check "name with spaces"    "$L" '"name":"dir with spaces"'
check "symlink target"      "$L" '"linkTarget":"nginx.conf"'
check "permissions as octal" "$L" '"mode":493'
L2=$(files '/entries?mount=/etc/dp&path=dir%20with%20spaces')
check "subdirectory with spaces" "$L2" 'my file.txt'

echo "reading"
R=$(files '/file?mount=/etc/dp&path=nginx.conf')
check "text file content" "$R" 'listen 80'
check "writable"          "$R" '"readOnly":false'
check "binary detected"   "$(files '/file?mount=/etc/dp&path=blob.bin')" '"binary":true'
check "directory refused" "$(files '/file?mount=/etc/dp&path=conf.d')" '这是一个目录'
check "missing file"      "$(files '/file?mount=/etc/dp&path=nope')" '不存在'

echo "path traversal"
for p in '../../etc/passwd' '..%2f..%2fetc%2fpasswd' 'conf.d/../../x'; do
  check "rejected: $p" "$(files "/file?mount=/etc/dp&path=$p")" '非法路径'
done

echo "writing"
check "write"           "$(api -X PUT "$BASE/api/hosts/$HOST_ID/containers/$C/files/file" -H 'content-type: application/json' -d '{"mount":"/etc/dp","path":"api-test.txt","content":"written by test\n"}')" '"ok":true'
check "read back"       "$(files '/file?mount=/etc/dp&path=api-test.txt')" 'written by test'
check "read-only mount" "$(api -X PUT "$BASE/api/hosts/$HOST_ID/containers/$C/files/file" -H 'content-type: application/json' -d '{"mount":"/etc/ro","path":"nginx.conf","content":"x"}')" '只读'
check "mkdir"           "$(api -X POST "$BASE/api/hosts/$HOST_ID/containers/$C/files/mkdir" -H 'content-type: application/json' -d '{"mount":"/etc/dp","path":"api-dir/sub"}')" '"ok":true'
check "chmod"           "$(api -X POST "$BASE/api/hosts/$HOST_ID/containers/$C/files/chmod" -H 'content-type: application/json' -d '{"mount":"/etc/dp","path":"api-test.txt","mode":"0600"}')" '"ok":true'
check "chmod listing"   "$(files /entries?mount=/etc/dp | python3 -c "
import json,sys
e = next(x for x in json.load(sys.stdin)['entries'] if x['name'] == 'api-test.txt')
print(e['mode'])")" '384'
check "rename"          "$(api -X POST "$BASE/api/hosts/$HOST_ID/containers/$C/files/rename" -H 'content-type: application/json' -d '{"mount":"/etc/dp","from":"api-test.txt","to":"api-dir/moved.txt"}')" '"ok":true'
check "renamed file"    "$(files '/entries?mount=/etc/dp&path=api-dir')" 'moved.txt'

echo "download"
check "file download" "$(curl -s -b "$JAR" -D - -o /dev/null "$BASE/api/hosts/$HOST_ID/containers/$C/files/download?mount=/etc/dp&path=nginx.conf" | tr -d '\r' | grep -i '^content-type')" 'text/plain'
check "dir as tar"    "$(curl -s -b "$JAR" -D - -o /dev/null "$BASE/api/hosts/$HOST_ID/containers/$C/files/download?mount=/etc/dp&path=conf.d" | tr -d '\r' | grep -i '^content-type')" 'application/x-tar'

echo "upload"
printf 'uploaded\n' > /tmp/dp-upload-test.txt
check "upload"      "$(api -X POST "$BASE/api/hosts/$HOST_ID/containers/$C/files/upload?mount=/etc/dp&name=up.txt" --data-binary @/tmp/dp-upload-test.txt)" '"ok":true'
check "uploaded file" "$(files '/file?mount=/etc/dp&path=up.txt')" 'uploaded'

echo "deleting"
check "refuse non-empty dir" "$(api -X DELETE "$BASE/api/hosts/$HOST_ID/containers/$C/files/path?mount=/etc/dp&path=api-dir")" '目录不为空'
check "delete file"          "$(api -X DELETE "$BASE/api/hosts/$HOST_ID/containers/$C/files/path?mount=/etc/dp&path=up.txt")" '"ok":true'
check "recursive delete"     "$(api -X DELETE "$BASE/api/hosts/$HOST_ID/containers/$C/files/path?mount=/etc/dp&path=api-dir&recursive=1")" '"ok":true'
check "deleted"              "$(files /entries?mount=/etc/dp)" '' 

echo "volumes and containers without mounts"
# Data volumes are out of scope for the file browser and say so, with or without an explicit mount.
check "volume listed"  "$(api "$BASE/api/hosts/$HOST_ID/containers/dp-demo-files-vol/files/mounts")" '"browsable":false'
check "volume refused" "$(api "$BASE/api/hosts/$HOST_ID/containers/dp-demo-files-vol/files/entries?mount=/data")" '数据卷'
check "no mounts"        "$(api "$BASE/api/hosts/$HOST_ID/containers/dp-demo-nomount/files/entries")" '没有挂载任何目录'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
