<script setup lang="ts">
/**
 * MahjongTile：單張麻將牌。數牌顯示數字＋花色字（萬紅/筒藍/條綠），
 * 字牌單字大顯（中紅、發綠、其餘墨黑）。face-down 渲染牌背。
 */
import { computed } from 'vue';
import { tileLabel, tileSuitGroup, type TileKind } from '@casino/shared';

const props = defineProps<{
  kind?: TileKind;
  size?: 'sm' | 'md';
  faceDown?: boolean;
  highlight?: boolean;
}>();

const label = computed(() => (props.kind !== undefined ? tileLabel(props.kind) : ''));
const group = computed(() => (props.kind !== undefined ? tileSuitGroup(props.kind) : 'honor'));
const isHonor = computed(() => group.value === 'honor');
const honorClass = computed(() => {
  if (props.kind === 'RED') return 'honor-red';
  if (props.kind === 'GREEN') return 'honor-green';
  return 'honor-ink';
});
</script>

<template>
  <div
    class="tile"
    :class="[size === 'sm' ? 'tile--sm' : 'tile--md', { 'tile--down': faceDown, 'tile--hit': highlight }]"
  >
    <template v-if="!faceDown && kind !== undefined">
      <span v-if="isHonor" class="honor" :class="honorClass">{{ label }}</span>
      <template v-else>
        <span class="num" :class="`num--${group}`">{{ label.charAt(0) }}</span>
        <span class="suit" :class="`num--${group}`">{{ label.charAt(1) }}</span>
      </template>
    </template>
  </div>
</template>

<style scoped>
.tile {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: linear-gradient(160deg, #fffef8 0%, #f2eedd 100%);
  border: 1px solid #c9c2a6;
  border-bottom-width: 4px;
  border-radius: 6px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
  user-select: none;
  line-height: 1;
}
.tile--md {
  width: 40px;
  height: 56px;
}
.tile--sm {
  width: 30px;
  height: 42px;
}
.tile--down {
  background: repeating-linear-gradient(135deg, #2c6e49, #2c6e49 6px, #275f40 6px, #275f40 12px);
  border-color: #1e4d33;
}
.tile--hit {
  outline: 3px solid #eab308;
  outline-offset: 1px;
}
.num {
  font-size: 18px;
  font-weight: 700;
}
.tile--sm .num {
  font-size: 14px;
}
.suit {
  font-size: 12px;
  margin-top: 2px;
}
.tile--sm .suit {
  font-size: 10px;
}
.honor {
  font-size: 22px;
  font-weight: 700;
}
.tile--sm .honor {
  font-size: 16px;
}
.num--man {
  color: #b91c1c;
}
.num--pin {
  color: #1d4ed8;
}
.num--sou {
  color: #15803d;
}
.honor-red {
  color: #b91c1c;
}
.honor-green {
  color: #15803d;
}
.honor-ink {
  color: #1f2937;
}
</style>
