<script setup lang="ts">
import { UsersRound } from "@lucide/vue";
import { computed } from "vue";
import type { ProjectPresenceMember } from "../../../lib/realtime";
import { getDocumentPresenceMembers } from "../lib/documentPresence";

const props = defineProps<{
  members: ProjectPresenceMember[];
  currentUserId: string;
  currentUser?: ProjectPresenceMember | null;
}>();
const memberCount = computed(() =>
  getDocumentPresenceMembers(props.members, props.currentUserId, props.currentUser).members.length,
);
</script>

<template>
  <span
    v-if="memberCount > 0"
    class="image-document-presence"
    :class="{ 'has-many-people': memberCount > 99 }"
    :aria-label="`${memberCount} ${memberCount === 1 ? 'person is' : 'people are'} in this document`"
  >
    <UsersRound :size="16" :stroke-width="1.8" aria-hidden="true" />
    <span aria-hidden="true">{{ memberCount > 99 ? '99+' : memberCount }}</span>
  </span>
</template>

<style scoped>
  .image-document-presence {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-width: 28px;
    padding: 0 3px;
    color: #ffffff;
    background: transparent;
    border: 0;
    font-size: 0.68rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  svg { flex: 0 0 auto; }
  .has-many-people { gap: 2px; }
  .has-many-people svg { width: 14px; height: 14px; }
</style>
