<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";

  interface Props {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    destructive?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }

  let {
    open,
    title,
    message,
    confirmLabel = "Confirm",
    destructive = false,
    onConfirm,
    onCancel,
  }: Props = $props();

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen) onCancel();
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay />
    <Dialog.Content showCloseButton={false}>
      <Dialog.Header>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description>{message}</Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button variant="outline" onclick={onCancel}>Cancel</Button>
        <Button variant={destructive ? "destructive" : "default"} onclick={onConfirm}>{confirmLabel}</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
