<script lang="ts">
  /**
   * Admin → Transcription: the hub's default speech-to-text service for voice
   * notes. The form is `HubTranscriptionSettings`; this page only frames it.
   */
  import PageHeader from "$lib/components/page-header.svelte";
  import AdminTabs from "$lib/components/admin/AdminTabs.svelte";
  import HubTranscriptionSettings from "$lib/components/admin/HubTranscriptionSettings.svelte";
</script>

<PageHeader title="Admin" subtitle="How voice notes are transcribed" />

<div class="container mx-auto max-w-5xl space-y-6 px-4 py-6">
  <AdminTabs active="transcription" />
  <div class="max-w-xl">
    <HubTranscriptionSettings />
  </div>
</div>
