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

<div class="ap-page">
  <AdminTabs active="transcription" />
  <div class="max-w-xl">
    <HubTranscriptionSettings />
  </div>
</div>
