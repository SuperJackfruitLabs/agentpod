<script lang="ts">
  /**
   * Admin → Speech: the hub's default text-to-speech service for agents'
   * spoken replies. The form is `HubSpeechSettings`; this page only frames it.
   */
  import PageHeader from "$lib/components/page-header.svelte";
  import AdminTabs from "$lib/components/admin/AdminTabs.svelte";
  import HubSpeechSettings from "$lib/components/admin/HubSpeechSettings.svelte";
</script>

<PageHeader title="Admin" subtitle="How agents speak their replies" />

<div class="container mx-auto max-w-5xl space-y-6 px-4 py-6">
  <AdminTabs active="speech" />
  <div class="max-w-xl">
    <HubSpeechSettings />
  </div>
</div>
