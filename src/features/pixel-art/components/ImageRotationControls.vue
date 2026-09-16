<script setup lang="ts">
import { computed, ref, watch } from "vue";

const props = defineProps<{ degrees: number; canEdit: boolean; busy: boolean }>();
const emit = defineEmits<{
  "update:degrees": [degrees: number];
  apply: [];
}>();
const draft = ref(String(props.degrees));
watch(() => props.degrees, (degrees) => { draft.value = String(degrees); });
const canApply = computed(() =>
  props.canEdit && !props.busy && draft.value.trim() !== "" &&
  Number.isFinite(Number(draft.value)) && Number(draft.value) % 360 !== 0,
);
const updateDegrees = (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  draft.value = input.value;
  if (Number.isFinite(input.valueAsNumber)) emit("update:degrees", input.valueAsNumber);
};
</script>

<template>
  <div class="image-rotation-controls" role="group" aria-label="Pixel rotation">
    <label>
      <span>Rotate by</span>
      <input
        type="number"
        step="any"
        :value="draft"
        :disabled="!canEdit || busy"
        aria-label="Rotation angle in degrees"
        @input="updateDegrees"
        @keydown.enter.prevent="canApply && emit('apply')"
      />
      <span aria-hidden="true">°</span>
    </label>
    <button
      type="button"
      :disabled="!canApply"
      title="Apply rotation (Enter). Drag around the center to rotate; Shift snaps to 15°. Pixels outside the canvas are clipped."
      @click="emit('apply')"
    >Apply</button>
    <span class="image-rotation-controls__hint">Drag to rotate · Shift: 15°</span>
  </div>
</template>

<style scoped>
  .image-rotation-controls,
  label {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
  }
  label { color: #b6b6b6; }
  input,
  button {
    height: 30px;
    box-sizing: border-box;
    color: #eeeeee;
    background: #171717;
    border: 1px solid #3a3a3a;
    border-radius: 5px;
    font: inherit;
  }
  input { width: 66px; padding: 0 5px; font-variant-numeric: tabular-nums; }
  button { padding: 0 9px; cursor: pointer; }
  button:hover:not(:disabled) { background: #292929; }
  input:focus-visible,
  button:focus-visible { outline: 2px solid #ffffff; outline-offset: 1px; }
  :disabled { opacity: 0.4; cursor: not-allowed; }
  .image-rotation-controls__hint { margin-left: 6px; color: #989898; }
  @media (max-width: 768px) {
    input,
    button { height: 36px; }
    .image-rotation-controls__hint { display: none; }
  }
</style>
