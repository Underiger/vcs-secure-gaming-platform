#!/usr/bin/env bash
# 把 Online-casino-on-Pi4 專案 + docker 資料 (images/volumes/build cache) 搬到 USB SSD (/dev/sda)
# 用法: sudo bash migrate-to-ssd.sh
set -euo pipefail

SSD_DEV=/dev/sda
SSD_PART=/dev/sda1
MOUNT_POINT=/mnt/ssd
PROJECT_OLD=/home/scout/Online-casino-on-Pi4
PROJECT_NEW=$MOUNT_POINT/Online-casino-on-Pi4
DOCKER_DATA_NEW=$MOUNT_POINT/docker-data
TS=$(date +%Y%m%d-%H%M%S)
COMPOSE_FILES="-f docker-compose.arm64.yml"
ENV_FILE_OLD="$PROJECT_OLD/.env.production"
ENV_FILE_NEW="$PROJECT_NEW/.env.production"

if [[ $EUID -ne 0 ]]; then
  echo "請用 sudo 執行: sudo bash $0" >&2
  exit 1
fi

echo "=== 確認目標裝置 ==="
lsblk -o NAME,SIZE,TYPE,TRAN "$SSD_DEV"
read -rp "確認 $SSD_DEV 是要格式化的 SSD,且裡面沒有重要資料？(輸入 yes 繼續) " confirm
[[ "$confirm" == "yes" ]] || { echo "取消"; exit 1; }

echo "=== 1. 卸載並清空 $SSD_DEV ==="
umount "${SSD_PART}" 2>/dev/null || true
wipefs -a "$SSD_DEV"
parted "$SSD_DEV" --script mklabel gpt mkpart primary ext4 0% 100%
sleep 2
partprobe "$SSD_DEV"
mkfs.ext4 -F -L casino_ssd "$SSD_PART"

echo "=== 2. 掛載到 $MOUNT_POINT ==="
mkdir -p "$MOUNT_POINT"
mount "$SSD_PART" "$MOUNT_POINT"
SSD_UUID=$(blkid -s UUID -o value "$SSD_PART")

echo "=== 3. 寫入 /etc/fstab (備份至 /etc/fstab.bak-$TS) ==="
cp /etc/fstab "/etc/fstab.bak-$TS"
if ! grep -q "$SSD_UUID" /etc/fstab; then
  echo "UUID=$SSD_UUID $MOUNT_POINT ext4 defaults,noatime,nofail,x-systemd.device-timeout=10s 0 2" >> /etc/fstab
fi

chown scout:scout "$MOUNT_POINT"
mkdir -p "$DOCKER_DATA_NEW"
chown scout:scout "$DOCKER_DATA_NEW"

echo "=== 4. 停止 casino docker compose stack ==="
cd "$PROJECT_OLD"
sudo -u scout docker compose --env-file "$ENV_FILE_OLD" $COMPOSE_FILES down

echo "=== 5. 停止 docker daemon 並搬移 /var/lib/docker ==="
systemctl stop docker.socket docker.service
rsync -aHAX --info=progress2 /var/lib/docker/ "$DOCKER_DATA_NEW/"
mv /var/lib/docker "/var/lib/docker.bak-$TS"

echo "=== 6. 設定 docker data-root 指向 SSD ==="
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<EOF
{
  "data-root": "$DOCKER_DATA_NEW"
}
EOF

echo "=== 7. 確保開機時先掛載 SSD 才啟動 docker ==="
mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/override.conf <<EOF
[Unit]
RequiresMountsFor=$MOUNT_POINT
EOF
systemctl daemon-reload

echo "=== 8. 啟動 docker daemon ==="
systemctl start docker.service
docker info | grep "Docker Root Dir"

echo "=== 9. 搬移專案資料夾 ==="
sudo -u scout rsync -a "$PROJECT_OLD/" "$PROJECT_NEW/"
mv "$PROJECT_OLD" "${PROJECT_OLD}.bak-$TS"
ln -s "$PROJECT_NEW" "$PROJECT_OLD"

echo "=== 10. 重新啟動 casino stack (從 SSD) ==="
cd "$PROJECT_NEW"
sudo -u scout docker compose --env-file "$ENV_FILE_NEW" $COMPOSE_FILES up -d

echo "=== 完成。驗證: ==="
docker compose --env-file "$ENV_FILE_NEW" $COMPOSE_FILES ps
echo "舊 docker 資料備份在: /var/lib/docker.bak-$TS"
echo "舊專案資料夾備份在: ${PROJECT_OLD}.bak-$TS"
echo "確認運作正常幾天後，可手動刪除上述兩個 .bak 備份以釋放 SD 卡空間。"
