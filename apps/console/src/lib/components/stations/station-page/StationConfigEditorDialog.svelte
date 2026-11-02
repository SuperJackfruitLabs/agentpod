<script lang="ts">
  /**
   * The ConfigEditor dialog, opened via "Edit (diff)" in the FileBrowser. `path` is the file open
   * in it, or null when it is closed.
   */
  import ConfigEditor from "$lib/components/stations/ConfigEditor.svelte";
  import * as Dialog from "$lib/components/ui/dialog";

  interface Props {
    stationId: string;
    path: string | null;
    canWrite: boolean;
    /** After a save, so the file browser can evict its stale copy of the file. */
    onSaved: (path: string) => void;
  }

  let { stationId, path = $bindable(), canWrite, onSaved }: Props = $props();

  let configEditor: ConfigEditor | undefined = $state();
</script>

<Dialog.Root
  open={path !== null && canWrite}
  onOpenChange={(open) => {
    // Escape/overlay-close must go through the editor's unsaved-changes guard;
    // the editor calls onClose (below) once closing is actually safe.
    if (!open) {
      if (configEditor) {
        configEditor.requestClose();
      } else {
        path = null;
      }
    }
  }}
>
  <Dialog.Content
    class="flex h-[80vh] max-w-4xl sm:max-w-4xl flex-col overflow-hidden p-0"
    showCloseButton={false}
  >
    {#if path !== null && canWrite}
      <ConfigEditor
        bind:this={configEditor}
        {stationId}
        {path}
        onClose={() => (path = null)}
        {onSaved}
      />
    {/if}
  </Dialog.Content>
</Dialog.Root>
